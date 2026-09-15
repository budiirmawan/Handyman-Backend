import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { resolveBuildingClientId } from '../shifts';
import { structureContextService } from '../structure-context';
import { tenantBuildingContextRepository } from '../tenant-building-contexts';
import { tenantCompanyRepository } from '../tenant-companies';
import { tenantPicRepository } from '../tenant-pics';
import {
  handymanRequestAlreadyCancelledError,
  handymanRequestIdempotencyConflictError,
  handymanRequestNotFoundError,
  handymanRequestNumberAlreadyExistsError,
  handymanRequestSpaceMismatchError,
  handymanRequestStatusInvalidError,
  handymanRequestTenantCompanyMismatchError,
  handymanRequestTenantPicMismatchError,
} from './handyman-request.errors';
import { handymanRequestRepository } from './handyman-request.repository';
import type {
  CreateHandymanRequestInput,
  HandymanRequestFilters,
  HandymanRequestRecord,
  PublicHandymanRequest,
} from './handyman-request.types';
import {
  parseCreateHandymanRequestBody,
  parseHandymanRequestFilters,
  parseHandymanRequestIdParam,
} from './handyman-request.validation';

const UNIQUE_VIOLATION = '23505';

function isEffectiveNow(record: {
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
}): boolean {
  const now = Date.now();
  return (
    (record.effectiveFrom === null || record.effectiveFrom.getTime() <= now) &&
    (record.effectiveUntil === null || record.effectiveUntil.getTime() >= now)
  );
}

export function toPublic(record: HandymanRequestRecord): PublicHandymanRequest {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    spaceId: record.spaceId,
    tenantCompanyId: record.tenantCompanyId,
    tenantPicId: record.tenantPicId,
    customerName: record.customerName,
    customerPhone: record.customerPhone,
    customerEmail: record.customerEmail,
    createdByUserId: record.createdByUserId,
    operationalSurface: record.operationalSurface,
    inboundChannel: record.inboundChannel,
    requestNumber: record.requestNumber,
    title: record.title,
    description: record.description,
    priority: record.priority,
    status: record.status,
    idempotencyKey: record.idempotencyKey,
    requestedAt: record.requestedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function computeFingerprint(input: {
  buildingId: string;
  spaceId: string;
  tenantCompanyId?: string | null;
  tenantPicId?: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  operationalSurface?: string;
  inboundChannel: string;
  title: string;
  description?: string | null;
  priority?: string;
  requestedAt?: Date | string | null;
}): string {
  const requestedAtIso = input.requestedAt
    ? input.requestedAt instanceof Date
      ? input.requestedAt.toISOString()
      : new Date(input.requestedAt).toISOString()
    : null;

  const canonical = JSON.stringify({
    buildingId: input.buildingId,
    customerEmail: input.customerEmail ?? null,
    customerName: input.customerName,
    customerPhone: input.customerPhone ?? null,
    description: input.description ?? null,
    inboundChannel: input.inboundChannel,
    operationalSurface: input.operationalSurface ?? 'BM_SUPER_APP',
    priority: input.priority ?? 'MEDIUM',
    requestedAt: requestedAtIso,
    spaceId: input.spaceId,
    tenantCompanyId: input.tenantCompanyId ?? null,
    tenantPicId: input.tenantPicId ?? null,
    title: input.title,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

async function generateNextRequestNumber(
  clientId: string,
  date: Date,
  tx: Pick<PoolClient, 'query'>,
): Promise<string> {
  const year = date.getUTCFullYear();
  const prefix = `HMR-${year}-`;

  const result = await tx.query<{ requestNumber: string }>(
    `SELECT request_number AS "requestNumber"
     FROM handyman_requests
     WHERE client_id = $1 AND request_number LIKE $2
     ORDER BY request_number DESC
     LIMIT 1`,
    [clientId, `${prefix}%`],
  );

  let nextSequence = 1;
  if (result.rows.length > 0) {
    const lastNumber = result.rows[0].requestNumber;
    const match = lastNumber.match(new RegExp(`^HMR-${year}-(\\d+)$`));
    if (match) {
      nextSequence = parseInt(match[1], 10) + 1;
    }
  }

  return `${prefix}${String(nextSequence).padStart(6, '0')}`;
}

export async function createHandymanRequest(
  rawInput: unknown,
  actorUserId: string,
): Promise<PublicHandymanRequest> {
  const input = parseCreateHandymanRequestBody(rawInput);

  // 1. Authoritative building access check
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);

  // 2. Authoritative client identity derived from building
  const clientId = await resolveBuildingClientId(input.buildingId);

  // 3. Space -> Building integrity
  const spaceContext = await structureContextService.resolveSpaceContext(input.spaceId);
  if (spaceContext.building.id !== input.buildingId) {
    throw handymanRequestSpaceMismatchError();
  }

  // 4. Optional tenant relationship integrity
  if (input.tenantPicId && !input.tenantCompanyId) {
    throw handymanRequestTenantPicMismatchError();
  }

  if (input.tenantCompanyId) {
    const company = await tenantCompanyRepository.findById(input.tenantCompanyId);
    if (!company || company.status !== 'ACTIVE') {
      throw handymanRequestTenantCompanyMismatchError();
    }

    const buildingContext = await tenantBuildingContextRepository.findActive(
      input.tenantCompanyId,
      input.buildingId,
    );
    if (!buildingContext || !isEffectiveNow(buildingContext)) {
      throw handymanRequestTenantCompanyMismatchError();
    }

    if (input.tenantPicId) {
      const pic = await tenantPicRepository.findById(input.tenantPicId);
      if (
        !pic ||
        pic.tenantCompanyId !== input.tenantCompanyId ||
        pic.status !== 'ACTIVE'
      ) {
        throw handymanRequestTenantPicMismatchError();
      }
    }
  }

  const fingerprint = computeFingerprint(input);
  const effectiveRequestedAt =
    input.requestedAt instanceof Date
      ? input.requestedAt
      : input.requestedAt
        ? new Date(input.requestedAt)
        : new Date();

  // 5. Check idempotency outside transaction before taking locks
  if (input.idempotencyKey) {
    const existing = await handymanRequestRepository.findByIdempotencyKey(
      clientId,
      input.idempotencyKey,
    );
    if (existing) {
      if (existing.idempotencyFingerprint !== fingerprint) {
        throw handymanRequestIdempotencyConflictError();
      }
      return toPublic(existing);
    }
  }

  // 6. Transactional creation with request number serialization under parent client lock
  const result = await withTransaction(async (tx) => {
    if (input.idempotencyKey) {
      const existingInTx = await handymanRequestRepository.findByIdempotencyKey(
        clientId,
        input.idempotencyKey,
        tx,
      );
      if (existingInTx) {
        if (existingInTx.idempotencyFingerprint !== fingerprint) {
          throw handymanRequestIdempotencyConflictError();
        }
        return { record: existingInTx, created: false };
      }
    }

    // Lock parent client to serialize request number allocation
    await tx.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'handyman_requests',
      clientId,
    ]);

    const requestNumber = await generateNextRequestNumber(
      clientId,
      effectiveRequestedAt,
      tx,
    );

    let createResult: { record: HandymanRequestRecord; created: boolean };
    try {
      createResult = await handymanRequestRepository.create(
        {
          clientId,
          buildingId: input.buildingId,
          spaceId: input.spaceId,
          tenantCompanyId: input.tenantCompanyId ?? null,
          tenantPicId: input.tenantPicId ?? null,
          customerName: input.customerName,
          customerPhone: input.customerPhone ?? null,
          customerEmail: input.customerEmail ?? null,
          createdByUserId: actorUserId,
          operationalSurface: input.operationalSurface ?? 'BM_SUPER_APP',
          inboundChannel: input.inboundChannel,
          requestNumber,
          title: input.title,
          description: input.description ?? null,
          priority: input.priority ?? 'MEDIUM',
          status: 'SUBMITTED',
          idempotencyKey: input.idempotencyKey ?? null,
          idempotencyFingerprint: input.idempotencyKey ? fingerprint : null,
          requestedAt: effectiveRequestedAt,
        },
        tx,
      );
    } catch (error) {
      const candidate = error as { code?: string; constraint?: string };
      if (
        candidate.code === UNIQUE_VIOLATION &&
        candidate.constraint === 'handyman_requests_client_number_unique'
      ) {
        throw handymanRequestNumberAlreadyExistsError();
      }
      throw error;
    }

    if (!createResult.created) {
      if (createResult.record.idempotencyFingerprint !== fingerprint) {
        throw handymanRequestIdempotencyConflictError();
      }
      return { record: createResult.record, created: false };
    }

    // Record operational event - NO customer PII in audit metadata
    await recordOperationalEvent(
      {
        clientId: createResult.record.clientId,
        buildingId: createResult.record.buildingId,
        eventType: 'HANDYMAN_REQUEST_CREATED',
        entityType: 'HANDYMAN_REQUEST',
        entityId: createResult.record.id,
        actorUserId,
        summary: `Handyman request ${createResult.record.requestNumber} submitted.`,
        metadata: {
          requestNumber: createResult.record.requestNumber,
          inboundChannel: createResult.record.inboundChannel,
          priority: createResult.record.priority,
          spaceId: createResult.record.spaceId,
          tenantCompanyId: createResult.record.tenantCompanyId,
          tenantPicId: createResult.record.tenantPicId,
          operationalSurface: createResult.record.operationalSurface,
        },
      },
      tx,
    );

    return { record: createResult.record, created: true };
  });

  return toPublic(result.record);
}

export async function getHandymanRequestById(
  id: string,
  actorUserId: string,
): Promise<PublicHandymanRequest> {
  const parsedId = parseHandymanRequestIdParam(id);
  const record = await handymanRequestRepository.findById(parsedId);
  if (!record) {
    throw handymanRequestNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublic(record);
}

export async function listHandymanRequests(
  rawFilters: unknown,
  actorUserId: string,
): Promise<PublicHandymanRequest[]> {
  const filters: HandymanRequestFilters = parseHandymanRequestFilters(rawFilters);

  let accessibleBuildingIds: string[];
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
    accessibleBuildingIds = [filters.buildingId];
  } else {
    accessibleBuildingIds =
      await contextAccessService.getAccessibleBuildingIds(actorUserId);
    if (accessibleBuildingIds.length === 0) {
      return [];
    }
  }

  const records = await handymanRequestRepository.list(
    filters,
    accessibleBuildingIds,
  );
  return records.map(toPublic);
}

export async function cancelHandymanRequest(
  id: string,
  actorUserId: string,
): Promise<PublicHandymanRequest> {
  const parsedId = parseHandymanRequestIdParam(id);

  return withTransaction(async (tx) => {
    const record = await handymanRequestRepository.findById(parsedId, tx);
    if (!record) {
      throw handymanRequestNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);

    if (record.status === 'CANCELLED') {
      throw handymanRequestAlreadyCancelledError();
    }
    if (record.status !== 'SUBMITTED') {
      throw handymanRequestStatusInvalidError(
        'Only submitted handyman requests can be cancelled.',
      );
    }

    const updated = await handymanRequestRepository.updateStatus(
      parsedId,
      'CANCELLED',
      tx,
    );
    if (!updated) {
      throw handymanRequestNotFoundError();
    }

    await recordOperationalEvent(
      {
        clientId: updated.clientId,
        buildingId: updated.buildingId,
        eventType: 'HANDYMAN_REQUEST_CANCELLED',
        entityType: 'HANDYMAN_REQUEST',
        entityId: updated.id,
        actorUserId,
        summary: `Handyman request ${updated.requestNumber} cancelled.`,
        metadata: {
          requestNumber: updated.requestNumber,
          previousStatus: record.status,
          newStatus: 'CANCELLED',
        },
      },
      tx,
    );

    return toPublic(updated);
  });
}

export const handymanRequestService = {
  cancelHandymanRequest,
  computeFingerprint,
  createHandymanRequest,
  getHandymanRequestById,
  listHandymanRequests,
  toPublic,
};

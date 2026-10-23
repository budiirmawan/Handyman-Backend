import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { vendorRepository } from '../vendors';
import { handymanProviderContextRepository } from './handyman-provider-context.repository';
import {
  handymanProviderContextAlreadyExistsError,
  handymanProviderContextInvalidStatusError,
  handymanProviderContextNotFoundError,
  handymanProviderVendorNotFoundError,
} from './handyman-provider-context.errors';
import {
  isHandymanProviderContextStatus,
  type CreateDirectHandymanProviderContextInput,
  type CreateHandymanProviderContextInput,
  type HandymanProviderContextRecord,
  type PublicHandymanProviderContext,
} from './handyman-provider-context.types';

/**
 * CR-HM-04 PART 01 — Handyman Provider Context service
 * (FROZEN F1/F8/F9/F10).
 *
 * `vendors` remains the authoritative provider identity: creation derives
 * clientId verbatim from the vendor authority row. The actor is ALWAYS
 * the explicit authenticated local user (never vendor PIC, workforce
 * profile, tenantPic, channel attribution, or BM identity). Realm
 * validation uses the existing accessible-Client convention over the
 * vendor-derived scope only. Lifecycle = ACTIVE ⇄ INACTIVE only; no
 * delete; state changes journal atomically with the projection.
 */

const CONTEXT_UNIQUE_CONSTRAINT = 'handyman_provider_contexts_vendor_unique';
const DIRECT_CONTEXT_UNIQUE_CONSTRAINT =
  'handyman_provider_contexts_direct_client_unique';

function isContextUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    (candidate?.constraint === CONTEXT_UNIQUE_CONSTRAINT ||
      candidate?.constraint === DIRECT_CONTEXT_UNIQUE_CONSTRAINT)
  );
}

function toPublic(
  record: HandymanProviderContextRecord,
): PublicHandymanProviderContext {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function ensureUuid(value: string, field: string): void {
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

/** Create the single ACTIVE Handyman provider context for a vendor. */
export async function createHandymanProviderContext(
  input: CreateHandymanProviderContextInput,
  actorUserId: string,
): Promise<PublicHandymanProviderContext> {
  ensureUuid(input.vendorId, 'vendorId');
  ensureUuid(actorUserId, 'actorUserId');

  // Derive the client scope from the vendor authority (never caller).
  const vendor = await vendorRepository.findById(input.vendorId);
  if (!vendor) throw handymanProviderVendorNotFoundError();
  if (
    !(await contextAccessService.canAccessClient(actorUserId, vendor.clientId))
  ) {
    throw buildingAccessDeniedError();
  }

  try {
    return await withTransaction(async (tx) => {
      const existing = await handymanProviderContextRepository.findByVendor(
        tx,
        input.vendorId,
      );
      if (existing) throw handymanProviderContextAlreadyExistsError();

      const record = await handymanProviderContextRepository.insertContext(
        tx,
        {
          clientId: vendor.clientId,
          providerType: 'VENDOR',
          vendorId: vendor.id,
          createdByUserId: actorUserId,
        },
        actorUserId,
      );

      // FROZEN F10 journal — SAME executor; history/audit only.
      await recordOperationalEvent(
        {
          clientId: record.clientId,
          eventType: 'HANDYMAN_PROVIDER_CONTEXT_CREATED',
          entityType: 'HANDYMAN_PROVIDER_CONTEXT',
          entityId: record.id,
          actorUserId,
          summary: 'Handyman provider context created (ACTIVE).',
          metadata: {
            providerContextId: record.id,
            providerType: 'VENDOR',
            vendorId: vendor.id,
          },
        },
        tx,
      );

      return toPublic(record);
    });
  } catch (error) {
    if (isContextUniqueViolation(error)) {
      throw handymanProviderContextAlreadyExistsError();
    }
    throw error;
  }
}

/**
 * PART 03B2D — create the Client's DIRECT workforce pool.
 *
 * Handyman is a direct service provider: Operations manages permanent,
 * contract and freelance field workers itself. This pool therefore has NO
 * vendor and none is fabricated. There is at most ONE per Client (enforced by
 * the partial unique index), so the whole workforce of a Client lives in a
 * single, unambiguous authority — the same provider/crew/worker chain the
 * assignment service already validates and journals.
 *
 * The Client is caller-supplied only because no vendor exists to derive it
 * from; the actor must have real access to that exact Client.
 */
export async function createDirectHandymanProviderContext(
  input: CreateDirectHandymanProviderContextInput,
  actorUserId: string,
): Promise<PublicHandymanProviderContext> {
  ensureUuid(input.clientId, 'clientId');
  ensureUuid(actorUserId, 'actorUserId');

  if (
    !(await contextAccessService.canAccessClient(actorUserId, input.clientId))
  ) {
    throw buildingAccessDeniedError();
  }

  try {
    return await withTransaction(async (tx) => {
      const existing = await handymanProviderContextRepository.findDirectByClient(
        tx,
        input.clientId,
      );
      if (existing) throw handymanProviderContextAlreadyExistsError();

      const record = await handymanProviderContextRepository.insertContext(
        tx,
        {
          clientId: input.clientId,
          providerType: 'DIRECT',
          vendorId: null,
          createdByUserId: actorUserId,
        },
        actorUserId,
      );

      await recordOperationalEvent(
        {
          clientId: record.clientId,
          eventType: 'HANDYMAN_PROVIDER_CONTEXT_CREATED',
          entityType: 'HANDYMAN_PROVIDER_CONTEXT',
          entityId: record.id,
          actorUserId,
          summary: 'Handyman direct workforce pool created (ACTIVE).',
          metadata: {
            providerContextId: record.id,
            providerType: 'DIRECT',
            vendorId: null,
          },
        },
        tx,
      );

      return toPublic(record);
    });
  } catch (error) {
    if (isContextUniqueViolation(error)) {
      throw handymanProviderContextAlreadyExistsError();
    }
    throw error;
  }
}

/** PART 03B2D — bounded read of the Client's direct pool. */
export async function getDirectHandymanProviderContext(
  clientId: string,
  actorUserId?: string,
): Promise<PublicHandymanProviderContext> {
  ensureUuid(clientId, 'clientId');
  const record = await handymanProviderContextRepository.findDirectByClient(
    undefined,
    clientId,
  );
  if (!record) throw handymanProviderContextNotFoundError();
  if (actorUserId !== undefined) {
    ensureUuid(actorUserId, 'actorUserId');
    if (
      !(await contextAccessService.canAccessClient(actorUserId, record.clientId))
    ) {
      throw buildingAccessDeniedError();
    }
  }
  return toPublic(record);
}

/** Lifecycle transition: ACTIVE ⇄ INACTIVE, with history preserved. */
export async function setHandymanProviderContextStatus(
  providerContextId: string,
  status: string,
  actorUserId: string,
): Promise<PublicHandymanProviderContext> {
  ensureUuid(providerContextId, 'providerContextId');
  ensureUuid(actorUserId, 'actorUserId');
  if (!isHandymanProviderContextStatus(status)) {
    throw handymanProviderContextInvalidStatusError();
  }

  return withTransaction(async (tx) => {
    const existing = await handymanProviderContextRepository.lockById(
      tx,
      providerContextId,
    );
    if (!existing) throw handymanProviderContextNotFoundError();
    if (
      !(await contextAccessService.canAccessClient(
        actorUserId,
        existing.clientId,
      ))
    ) {
      throw buildingAccessDeniedError();
    }
    if (existing.status === status) {
      throw handymanProviderContextInvalidStatusError();
    }

    const projected = await handymanProviderContextRepository.updateStatus(
      tx,
      providerContextId,
      status,
    );
    if (!projected) throw handymanProviderContextNotFoundError();

    await recordOperationalEvent(
      {
        clientId: existing.clientId,
        eventType: 'HANDYMAN_PROVIDER_CONTEXT_STATUS_CHANGED',
        entityType: 'HANDYMAN_PROVIDER_CONTEXT',
        entityId: existing.id,
        actorUserId,
        summary: `Handyman provider context status: ${existing.status} → ${status}.`,
        metadata: {
          providerContextId: existing.id,
          providerType: existing.providerType,
          vendorId: existing.vendorId,
          fromStatus: existing.status,
          toStatus: status,
        },
      },
      tx,
    );

    return toPublic(projected);
  });
}

/** Bounded read by vendor; optional actor enforces accessible-Client scope. */
export async function getHandymanProviderContextByVendor(
  vendorId: string,
  actorUserId?: string,
): Promise<PublicHandymanProviderContext> {
  ensureUuid(vendorId, 'vendorId');
  const record = await handymanProviderContextRepository.findByVendor(
    undefined,
    vendorId,
  );
  if (!record) throw handymanProviderContextNotFoundError();
  if (actorUserId !== undefined) {
    ensureUuid(actorUserId, 'actorUserId');
    if (
      !(await contextAccessService.canAccessClient(
        actorUserId,
        record.clientId,
      ))
    ) {
      throw buildingAccessDeniedError();
    }
  }
  return toPublic(record);
}

export const handymanProviderContextService = {
  createHandymanProviderContext,
  createDirectHandymanProviderContext,
  getDirectHandymanProviderContext,
  setHandymanProviderContextStatus,
  getHandymanProviderContextByVendor,
};

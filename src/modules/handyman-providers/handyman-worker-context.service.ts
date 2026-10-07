import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { organizationRepository } from '../organizations';
import { vendorWorkforceRepository } from '../vendor-workforce';
import { workforceRepository } from '../workforce';
import { handymanProviderContextRepository } from './handyman-provider-context.repository';
import {
  handymanWorkerContextAlreadyExistsError,
  handymanWorkerContextInvalidStatusError,
  handymanWorkerContextNotFoundError,
  handymanWorkforceBindingRequiredError,
} from './handyman-worker-context.errors';
import { handymanProviderContextNotFoundError } from './handyman-provider-context.errors';
import { handymanWorkerContextRepository } from './handyman-worker-context.repository';
import {
  isHandymanWorkerContextStatus,
  type CreateHandymanWorkerContextInput,
  type HandymanWorkerContextRecord,
  type PublicHandymanWorkerContext,
} from './handyman-worker-context.types';

/**
 * CR-HM-04 PART 02 — Handyman Worker Context service
 * (FROZEN F2/F5/F8/F9/F10).
 *
 * Eligibility chain (all read-only against existing authorities):
 *   1. Provider context exists and is ACTIVE (PART 01).
 *   2. Workforce profile exists (workforce_profiles authoritative person
 *      master; `userId` may be NULL — helpers need no login, F5).
 *   3. Person Client chain: profile.organizationId → organizations →
 *      client_id MUST equal the provider context's client (snapshot of
 *      the vendor authority).
 *   4. An ACTIVE vendor↔workforce binding for the SAME vendor is required
 *      (mandatory business model: the worker belongs to the provider via
 *      the vendor-authoritative binding seam). If it is absent: reject —
 *      never synthesized, and vendor tables are NEVER modified here.
 *
 * Actor and scope follow PART 01 (explicit authenticated local user +
 * accessible-Client convention; never derived from workforce profile or
 * vendor/provider PIC). No crew membership, attendance, session,
 * skill/discipline authority, or assignment exists in this surface.
 */

const CONTEXT_UNIQUE_CONSTRAINT = 'handyman_worker_contexts_pair_unique';

function isContextUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate?.code === '23505' &&
    candidate?.constraint === CONTEXT_UNIQUE_CONSTRAINT
  );
}

function toPublic(
  record: HandymanWorkerContextRecord,
): PublicHandymanWorkerContext {
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

function bindingStands(
  effectiveFrom: Date | null,
  effectiveUntil: Date | null,
): boolean {
  const now = Date.now();
  if (effectiveFrom && effectiveFrom.getTime() > now) return false;
  if (effectiveUntil && effectiveUntil.getTime() <= now) return false;
  return true;
}

/** Create the ACTIVE worker context under one ACTIVE provider context. */
export async function createHandymanWorkerContext(
  input: CreateHandymanWorkerContextInput,
  actorUserId: string,
): Promise<PublicHandymanWorkerContext> {
  ensureUuid(input.handymanProviderContextId, 'handymanProviderContextId');
  ensureUuid(input.workforceProfileId, 'workforceProfileId');
  ensureUuid(actorUserId, 'actorUserId');

  // 1) Provider context authority (PART 01) — must exist and be ACTIVE.
  const providerContext = await handymanProviderContextRepository.findById(
    undefined,
    input.handymanProviderContextId,
  );
  if (!providerContext) throw handymanProviderContextNotFoundError();
  if (providerContext.status !== 'ACTIVE') {
    throw handymanWorkforceBindingRequiredError();
  }

  // Realm authority: existing accessible-Client convention.
  if (
    !(await contextAccessService.canAccessClient(
      actorUserId,
      providerContext.clientId,
    ))
  ) {
    throw buildingAccessDeniedError();
  }

  // 2) Person identity authority (NEVER duplicated; userId may be NULL).
  const profile = await workforceRepository.findById(input.workforceProfileId);
  if (!profile) throw handymanWorkforceBindingRequiredError();

  // 3) Client chain via the profile's organization root.
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization || organization.clientId !== providerContext.clientId) {
    throw handymanWorkforceBindingRequiredError();
  }

  // 4) Vendor-authoritative personnel link — required, read-only.
  const binding = await vendorWorkforceRepository
    .findActiveByVendorAndWorkforce(
      providerContext.vendorId,
      input.workforceProfileId,
    );
  if (!binding || !bindingStands(binding.effectiveFrom, binding.effectiveUntil)) {
    throw handymanWorkforceBindingRequiredError();
  }

  try {
    return await withTransaction(async (tx) => {
      const existing = await handymanWorkerContextRepository
        .findByProviderAndProfile(
          tx,
          providerContext.id,
          input.workforceProfileId,
        );
      if (existing) throw handymanWorkerContextAlreadyExistsError();

      const record = await handymanWorkerContextRepository.insertContext(
        tx,
        {
          clientId: providerContext.clientId,
          handymanProviderContextId: providerContext.id,
          workforceProfileId: input.workforceProfileId,
          createdByUserId: actorUserId,
        },
        actorUserId,
      );

      // FROZEN F10 journal — SAME executor; history/audit only.
      await recordOperationalEvent(
        {
          clientId: record.clientId,
          eventType: 'HANDYMAN_WORKER_CONTEXT_CREATED',
          entityType: 'HANDYMAN_WORKER_CONTEXT',
          entityId: record.id,
          actorUserId,
          summary: 'Handyman worker context created (ACTIVE).',
          metadata: {
            workerContextId: record.id,
            providerContextId: providerContext.id,
            workforceProfileId: record.workforceProfileId,
          },
        },
        tx,
      );

      return toPublic(record);
    });
  } catch (error) {
    if (isContextUniqueViolation(error)) {
      throw handymanWorkerContextAlreadyExistsError();
    }
    throw error;
  }
}

/** Lifecycle transition: ACTIVE ⇄ INACTIVE, with history journaled. */
export async function setHandymanWorkerContextStatus(
  workerContextId: string,
  status: string,
  actorUserId: string,
): Promise<PublicHandymanWorkerContext> {
  ensureUuid(workerContextId, 'workerContextId');
  ensureUuid(actorUserId, 'actorUserId');
  if (!isHandymanWorkerContextStatus(status)) {
    throw handymanWorkerContextInvalidStatusError();
  }

  return withTransaction(async (tx) => {
    const existing = await handymanWorkerContextRepository.lockById(
      tx,
      workerContextId,
    );
    if (!existing) throw handymanWorkerContextNotFoundError();
    if (
      !(await contextAccessService.canAccessClient(
        actorUserId,
        existing.clientId,
      ))
    ) {
      throw buildingAccessDeniedError();
    }
    if (existing.status === status) {
      throw handymanWorkerContextInvalidStatusError();
    }

    const projected = await handymanWorkerContextRepository.updateStatus(
      tx,
      workerContextId,
      status,
    );
    if (!projected) throw handymanWorkerContextNotFoundError();

    await recordOperationalEvent(
      {
        clientId: existing.clientId,
        eventType: 'HANDYMAN_WORKER_CONTEXT_STATUS_CHANGED',
        entityType: 'HANDYMAN_WORKER_CONTEXT',
        entityId: existing.id,
        actorUserId,
        summary: `Handyman worker context status: ${existing.status} → ${status}.`,
        metadata: {
          workerContextId: existing.id,
          providerContextId: existing.handymanProviderContextId,
          workforceProfileId: existing.workforceProfileId,
          fromStatus: existing.status,
          toStatus: status,
        },
      },
      tx,
    );

    return toPublic(projected);
  });
}

/** Bounded read; optional actor enforces the existing scope convention. */
export async function getHandymanWorkerContext(
  workerContextId: string,
  actorUserId?: string,
): Promise<PublicHandymanWorkerContext> {
  ensureUuid(workerContextId, 'workerContextId');
  const record = await handymanWorkerContextRepository.findById(
    undefined,
    workerContextId,
  );
  if (!record) throw handymanWorkerContextNotFoundError();
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

export const handymanWorkerContextService = {
  createHandymanWorkerContext,
  setHandymanWorkerContextStatus,
  getHandymanWorkerContext,
};

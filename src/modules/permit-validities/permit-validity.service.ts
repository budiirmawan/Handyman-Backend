import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import { permitApprovalRepository } from '../permit-approvals/permit-approval.repository';
import { resolvePermitSafetyReadiness } from '../permit-safety-requirements/permit-safety-requirement.service';
import { permitRepository } from '../permits/permit.repository';
import {
  permitValidityAlreadyOpenError,
  permitValidityBuildingMismatchError,
  permitValidityContextInvalidError,
  permitValidityInvalidRangeError,
  permitValidityNotFoundError,
  permitValidityRevokeNotAllowedError,
} from './permit-validity.errors';
import { permitValidityRepository } from './permit-validity.repository';
import type {
  NewPermitValidity,
  PermitValidityFilters,
  PermitValidityRecord,
  PermitValidityState,
  PublicPermitValidity,
  RevokePermitValidityInput,
  SetPermitValidityInput,
} from './permit-validity.types';

export function toPublicPermitValidity(
  record: PermitValidityRecord,
): PublicPermitValidity {
  return {
    ...record,
    active: record.status === 'VALID',
    validFrom: record.validFrom.toISOString(),
    validUntil: record.validUntil.toISOString(),
    activatedAt: record.activatedAt?.toISOString() ?? null,
    expiredAt: record.expiredAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function assertValidRange(validFrom: Date, validUntil: Date): void {
  const from = validFrom.getTime();
  const until = validUntil.getTime();
  if (Number.isNaN(from) || Number.isNaN(until) || until <= from) {
    throw permitValidityInvalidRangeError();
  }
}

async function assertApprovedContext(
  permitId: string,
  permitApplicationId: string,
  buildingId: string,
  actorUserId: string,
): Promise<{
  clientId: string;
  applicationId: string;
}> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitValidityContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  if (buildingId !== permit.buildingId) {
    throw permitValidityBuildingMismatchError();
  }
  const application = await permitApplicationRepository.findById(
    permitApplicationId,
  );
  if (
    !application ||
    application.permitId !== permit.id ||
    application.buildingId !== permit.buildingId ||
    application.status !== 'SUBMITTED' ||
    application.permitStatus !== 'DRAFT'
  ) {
    throw permitValidityContextInvalidError();
  }
  const approvals = await permitApprovalRepository.listByApplication(
    application.id,
  );
  if (
    approvals.length === 0 ||
    approvals.some((approval) =>
      approval.reviewStatus !== 'COMPLETED' ||
      approval.decision !== 'APPROVED')
  ) {
    throw permitValidityContextInvalidError();
  }
  const safety = await resolvePermitSafetyReadiness(permit.id, actorUserId);
  if (!safety.ready) throw permitValidityContextInvalidError();
  return { clientId: permit.clientId, applicationId: application.id };
}

function initialValidity(input: SetPermitValidityInput): Pick<
  NewPermitValidity,
  'status' | 'activatedAt' | 'expiredAt'
> {
  const now = Date.now();
  if (input.validUntil.getTime() <= now) {
    return {
      status: 'EXPIRED',
      activatedAt: input.validFrom,
      expiredAt: input.validUntil,
    };
  }
  if (input.validFrom.getTime() <= now) {
    return { status: 'VALID', activatedAt: new Date(), expiredAt: null };
  }
  return { status: 'PENDING', activatedAt: null, expiredAt: null };
}

function isOpenUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'permit_validity_open_unique';
}

export async function setPermitValidity(
  permitId: string,
  input: SetPermitValidityInput,
  actorUserId: string,
): Promise<PublicPermitValidity> {
  assertValidRange(input.validFrom, input.validUntil);
  const context = await assertApprovedContext(
    permitId,
    input.permitApplicationId,
    input.buildingId,
    actorUserId,
  );

  const open = await permitValidityRepository.findOpenByApplicationId(
    context.applicationId,
  );
  if (open) {
    const resolved = await resolveValidityRecord(open, actorUserId);
    if (resolved.status === 'PENDING' || resolved.status === 'VALID') {
      throw permitValidityAlreadyOpenError();
    }
  }

  const state = initialValidity(input);
  const newValidity: NewPermitValidity = {
    permitApplicationId: context.applicationId,
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    ...state,
    notes: input.notes ?? null,
    createdByUserId: actorUserId,
  };
  try {
    const created = await permitValidityRepository.create(newValidity);
    await recordValidityEvent(
      created,
      actorUserId,
      'PERMIT_VALIDITY_SET',
      'Permit validity period set',
      {
        status: created.status,
        validFrom: created.validFrom.toISOString(),
        validUntil: created.validUntil.toISOString(),
      },
    );
    return toPublicPermitValidity(created);
  } catch (error) {
    if (isOpenUniqueViolation(error)) throw permitValidityAlreadyOpenError();
    throw error;
  }
}

async function resolveValidityRecord(
  record: PermitValidityRecord,
  actorUserId: string,
): Promise<PermitValidityRecord> {
  if (record.status === 'EXPIRED' || record.status === 'REVOKED') return record;
  const resolved = await permitValidityRepository.transitionDue(record.id);
  if (!resolved) throw permitValidityNotFoundError();
  if (resolved.status !== record.status) {
    const eventType = resolved.status === 'VALID'
      ? 'PERMIT_VALIDITY_ACTIVATED'
      : 'PERMIT_VALIDITY_EXPIRED';
    await recordValidityEvent(
      resolved,
      actorUserId,
      eventType,
      resolved.status === 'VALID'
        ? 'Permit validity activated'
        : 'Permit validity expired',
      { fromStatus: record.status, toStatus: resolved.status },
    );
  }
  return resolved;
}

export async function getPermitValidity(
  id: string,
  actorUserId: string,
): Promise<PublicPermitValidity> {
  const record = await permitValidityRepository.findById(id);
  if (!record) throw permitValidityNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublicPermitValidity(await resolveValidityRecord(record, actorUserId));
}

export async function resolveCurrentPermitValidity(
  permitId: string,
  actorUserId: string,
): Promise<PermitValidityState> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitValidityContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  const records = await permitValidityRepository.listByPermitId(permit.id);
  const history: PublicPermitValidity[] = [];
  for (const record of records) {
    history.push(toPublicPermitValidity(
      await resolveValidityRecord(record, actorUserId),
    ));
  }
  return {
    permitId: permit.id,
    permitReference: permit.permitNumber,
    buildingId: permit.buildingId,
    currentValidity: history.length > 0 ? history[history.length - 1] : null,
    history,
  };
}

export async function revokePermitValidity(
  id: string,
  input: RevokePermitValidityInput,
  actorUserId: string,
): Promise<PublicPermitValidity> {
  const existing = await permitValidityRepository.findById(id);
  if (!existing) throw permitValidityNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  const current = await resolveValidityRecord(existing, actorUserId);
  if (current.status !== 'PENDING' && current.status !== 'VALID') {
    throw permitValidityRevokeNotAllowedError();
  }
  const revoked = await permitValidityRepository.revoke(
    current.id,
    input,
    actorUserId,
  );
  if (!revoked) throw permitValidityRevokeNotAllowedError();
  await recordValidityEvent(
    revoked,
    actorUserId,
    'PERMIT_VALIDITY_REVOKED',
    'Permit validity revoked',
    {
      fromStatus: current.status,
      toStatus: revoked.status,
      revocationNotes: revoked.revocationNotes,
    },
  );
  return toPublicPermitValidity(revoked);
}

export async function listPermitValidities(
  filters: PermitValidityFilters,
  actorUserId: string,
): Promise<PublicPermitValidity[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await permitValidityRepository.list(filters, buildingIds);
  const resolved: PublicPermitValidity[] = [];
  for (const record of records) {
    const item = toPublicPermitValidity(
      await resolveValidityRecord(record, actorUserId),
    );
    if (!filters.status || item.status === filters.status) resolved.push(item);
  }
  return resolved;
}

async function recordValidityEvent(
  validity: PermitValidityRecord,
  actorUserId: string,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordOperationalEvent({
    clientId: validity.clientId,
    buildingId: validity.buildingId,
    entityType: 'PERMIT_VALIDITY',
    entityId: validity.id,
    eventType,
    actorUserId,
    summary,
    metadata: {
      permitId: validity.permitId,
      permitApplicationId: validity.permitApplicationId,
      ...metadata,
    },
  });
}

export const permitValidityService = {
  getPermitValidity,
  listPermitValidities,
  resolveCurrentPermitValidity,
  revokePermitValidity,
  setPermitValidity,
  toPublicPermitValidity,
};

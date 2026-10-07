import { ERROR_CODES } from '../../shared/errors';
import { contractorContextService } from '../contractor-contexts/contractor-context.service';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import { resolveCurrentPermitValidity } from '../permit-validities/permit-validity.service';
import type { PublicPermitValidity } from '../permit-validities/permit-validity.types';
import { permitRepository } from '../permits/permit.repository';
import { vendorWorkforceRepository } from '../vendor-workforce/vendor-workforce.repository';
import { workforceRepository } from '../workforce/workforce.repository';
import {
  permitWorkerAlreadyActiveError,
  permitWorkerContextInvalidError,
  permitWorkerContractorInvalidError,
  permitWorkerContractorMismatchError,
  permitWorkerDeactivateNotAllowedError,
  permitWorkerInactiveError,
  permitWorkerInvalidError,
  permitWorkerInvalidValidityError,
  permitWorkerNotFoundError,
  permitWorkerUpdateNotAllowedError,
} from './permit-worker.errors';
import { permitWorkerRepository } from './permit-worker.repository';
import type {
  AddPermitWorkerInput,
  NewPermitWorker,
  PermitActiveWorkerList,
  PermitWorkerFilters,
  PermitWorkerRecord,
  PublicPermitWorker,
  UpdatePermitWorkerInput,
} from './permit-worker.types';

type OpenPermitWorkerContext = {
  permitId: string;
  permitReference: string;
  permitApplicationId: string;
  buildingId: string;
  contractorContextType: string;
  contractorContextId: string;
  contractorVendorId: string;
  validity: PublicPermitValidity;
};

function workerIsEligible(record: PermitWorkerRecord, now = Date.now()): boolean {
  return record.status === 'ACTIVE' &&
    record.permitValidityStatus === 'VALID' &&
    record.validFrom.getTime() <= now &&
    record.validUntil.getTime() > now &&
    record.workforceStatus === 'ACTIVE' &&
    record.workforceType === 'EXTERNAL' &&
    record.vendorWorkforceStatus === 'ACTIVE' &&
    (record.vendorWorkforceEffectiveFrom === null ||
      record.vendorWorkforceEffectiveFrom.getTime() <= now) &&
    (record.vendorWorkforceEffectiveUntil === null ||
      record.vendorWorkforceEffectiveUntil.getTime() > now);
}

export function toPublicPermitWorker(
  record: PermitWorkerRecord,
): PublicPermitWorker {
  return {
    ...record,
    workerPersonReference: record.workforceProfileId,
    identificationReference: record.vendorPersonnelCode,
    eligibleForActiveWork: workerIsEligible(record),
    vendorWorkforceEffectiveFrom:
      record.vendorWorkforceEffectiveFrom?.toISOString() ?? null,
    vendorWorkforceEffectiveUntil:
      record.vendorWorkforceEffectiveUntil?.toISOString() ?? null,
    validFrom: record.validFrom.toISOString(),
    validUntil: record.validUntil.toISOString(),
    deactivatedAt: record.deactivatedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function permitContractorContextId(permit: {
  contractorVendorId: string;
  tenantContractorRelationshipId: string | null;
}): string {
  return permit.tenantContractorRelationshipId ?? permit.contractorVendorId;
}

async function assertContractorContext(input: {
  contractorContextType: 'TENANT_CONTRACTOR' | 'VENDOR_CONTRACTOR';
  contractorContextId: string;
  buildingId: string;
}, actorUserId: string): Promise<void> {
  try {
    await contractorContextService.resolveContractorContext(input, actorUserId);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
    if (
      code === ERROR_CODES.CONTRACTOR_CONTEXT_INVALID ||
      code === ERROR_CODES.CONTRACTOR_CONTEXT_INACTIVE ||
      code === ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_MISMATCH ||
      code === ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_REQUIRED
    ) {
      throw permitWorkerContractorInvalidError();
    }
    throw error;
  }
}

async function loadOpenPermitContext(
  permitId: string,
  permitApplicationId: string,
  buildingId: string,
  actorUserId: string,
): Promise<OpenPermitWorkerContext> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitWorkerContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  if (buildingId !== permit.buildingId) throw permitWorkerContextInvalidError();
  const application = await permitApplicationRepository.findById(
    permitApplicationId,
  );
  if (
    !application ||
    application.permitId !== permit.id ||
    application.status !== 'SUBMITTED'
  ) {
    throw permitWorkerContextInvalidError();
  }
  const validityState = await resolveCurrentPermitValidity(
    permit.id,
    actorUserId,
  );
  const validity = validityState.currentValidity;
  if (
    !validity ||
    (validity.status !== 'PENDING' && validity.status !== 'VALID')
  ) {
    throw permitWorkerContextInvalidError();
  }
  const contractorContextId = permitContractorContextId(permit);
  await assertContractorContext({
    contractorContextType: permit.contractorContextType,
    contractorContextId,
    buildingId: permit.buildingId,
  }, actorUserId);
  return {
    permitId: permit.id,
    permitReference: permit.permitNumber,
    permitApplicationId: application.id,
    buildingId: permit.buildingId,
    contractorContextType: permit.contractorContextType,
    contractorContextId,
    contractorVendorId: permit.contractorVendorId,
    validity,
  };
}

function resolveWorkerPeriod(
  input: { validFrom?: Date; validUntil?: Date },
  permitValidity: PublicPermitValidity,
): { validFrom: Date; validUntil: Date } {
  const permitFrom = new Date(permitValidity.validFrom);
  const permitUntil = new Date(permitValidity.validUntil);
  const validFrom = input.validFrom ?? permitFrom;
  const validUntil = input.validUntil ?? permitUntil;
  const from = validFrom.getTime();
  const until = validUntil.getTime();
  if (
    Number.isNaN(from) ||
    Number.isNaN(until) ||
    until <= from ||
    from < permitFrom.getTime() ||
    until > permitUntil.getTime()
  ) {
    throw permitWorkerInvalidValidityError();
  }
  return { validFrom, validUntil };
}

async function resolveWorkerBinding(input: {
  workforceProfileId: string;
  expectedBindingId?: string;
  contractorVendorId: string;
  validFrom: Date;
  validUntil: Date;
}) {
  const profile = await workforceRepository.findById(input.workforceProfileId);
  if (!profile) throw permitWorkerInvalidError();
  if (profile.status !== 'ACTIVE') throw permitWorkerInactiveError();
  if (profile.workforceType !== 'EXTERNAL') throw permitWorkerInvalidError();

  const binding = await vendorWorkforceRepository.findByVendorAndWorkforce(
    input.contractorVendorId,
    profile.id,
  );
  if (!binding) {
    const otherBindings =
      await vendorWorkforceRepository.listByWorkforceProfileId(profile.id);
    if (otherBindings.length > 0) throw permitWorkerContractorMismatchError();
    throw permitWorkerInvalidError();
  }
  if (
    input.expectedBindingId &&
    input.expectedBindingId !== binding.id
  ) {
    throw permitWorkerContractorMismatchError();
  }
  if (binding.status !== 'ACTIVE') throw permitWorkerInactiveError();
  if (
    (binding.effectiveFrom && binding.effectiveFrom > input.validFrom) ||
    (binding.effectiveUntil && binding.effectiveUntil < input.validUntil)
  ) {
    throw permitWorkerInvalidValidityError();
  }
  return binding;
}

function isActiveUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'permit_worker_active_unique';
}

export async function addPermitWorker(
  permitId: string,
  input: AddPermitWorkerInput,
  actorUserId: string,
): Promise<PublicPermitWorker> {
  const context = await loadOpenPermitContext(
    permitId,
    input.permitApplicationId,
    input.buildingId,
    actorUserId,
  );
  const period = resolveWorkerPeriod(input, context.validity);
  const binding = await resolveWorkerBinding({
    workforceProfileId: input.workforceProfileId,
    expectedBindingId: input.vendorWorkforceBindingId,
    contractorVendorId: context.contractorVendorId,
    ...period,
  });
  if (await permitWorkerRepository.findActiveDuplicate(
    context.permitApplicationId,
    binding.id,
  )) {
    throw permitWorkerAlreadyActiveError();
  }
  const worker: NewPermitWorker = {
    permitApplicationId: context.permitApplicationId,
    vendorWorkforceBindingId: binding.id,
    roleTrade: input.roleTrade,
    ...period,
    notes: input.notes ?? null,
    actorUserId,
  };
  try {
    const created = await permitWorkerRepository.create(worker);
    await recordWorkerEvent(
      created,
      actorUserId,
      'PERMIT_WORKER_ADDED',
      'Worker added to Permit',
      {
        workforceProfileId: created.workforceProfileId,
        roleTrade: created.roleTrade,
        validFrom: created.validFrom.toISOString(),
        validUntil: created.validUntil.toISOString(),
      },
    );
    return toPublicPermitWorker(created);
  } catch (error) {
    if (isActiveUniqueViolation(error)) throw permitWorkerAlreadyActiveError();
    throw error;
  }
}

export async function getPermitWorker(
  id: string,
  actorUserId: string,
): Promise<PublicPermitWorker> {
  const worker = await permitWorkerRepository.findById(id);
  if (!worker) throw permitWorkerNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, worker.buildingId);
  return toPublicPermitWorker(worker);
}

export async function listPermitWorkers(
  filters: PermitWorkerFilters,
  actorUserId: string,
): Promise<PublicPermitWorker[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await permitWorkerRepository.list(filters, buildingIds)
  ).map(toPublicPermitWorker);
}

export async function listPermitWorkersForPermit(
  permitId: string,
  actorUserId: string,
): Promise<PublicPermitWorker[]> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitWorkerContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  return listPermitWorkers({ permitId }, actorUserId);
}

export async function updatePermitWorker(
  id: string,
  input: UpdatePermitWorkerInput,
  actorUserId: string,
): Promise<PublicPermitWorker> {
  const existing = await permitWorkerRepository.findById(id);
  if (!existing) throw permitWorkerNotFoundError();
  if (existing.status !== 'ACTIVE') throw permitWorkerUpdateNotAllowedError();
  const context = await loadOpenPermitContext(
    existing.permitId,
    existing.permitApplicationId,
    existing.buildingId,
    actorUserId,
  );
  const period = resolveWorkerPeriod({
    validFrom: input.validFrom ?? existing.validFrom,
    validUntil: input.validUntil ?? existing.validUntil,
  }, context.validity);
  await resolveWorkerBinding({
    workforceProfileId: existing.workforceProfileId,
    expectedBindingId: existing.vendorWorkforceBindingId,
    contractorVendorId: context.contractorVendorId,
    ...period,
  });
  const updated = await permitWorkerRepository.updateActive(id, {
    ...input,
    ...period,
  }, actorUserId);
  if (!updated) throw permitWorkerUpdateNotAllowedError();
  await recordWorkerEvent(
    updated,
    actorUserId,
    'PERMIT_WORKER_UPDATED',
    'Permit Worker entry updated',
    {
      before: {
        roleTrade: existing.roleTrade,
        validFrom: existing.validFrom.toISOString(),
        validUntil: existing.validUntil.toISOString(),
        notes: existing.notes,
      },
      after: {
        roleTrade: updated.roleTrade,
        validFrom: updated.validFrom.toISOString(),
        validUntil: updated.validUntil.toISOString(),
        notes: updated.notes,
      },
    },
  );
  return toPublicPermitWorker(updated);
}

export async function deactivatePermitWorker(
  id: string,
  actorUserId: string,
): Promise<PublicPermitWorker> {
  const existing = await permitWorkerRepository.findById(id);
  if (!existing) throw permitWorkerNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.status !== 'ACTIVE') {
    throw permitWorkerDeactivateNotAllowedError();
  }
  const deactivated = await permitWorkerRepository.deactivate(id, actorUserId);
  if (!deactivated) throw permitWorkerDeactivateNotAllowedError();
  await recordWorkerEvent(
    deactivated,
    actorUserId,
    'PERMIT_WORKER_DEACTIVATED',
    'Permit Worker entry deactivated',
    { workforceProfileId: deactivated.workforceProfileId },
  );
  return toPublicPermitWorker(deactivated);
}

export async function resolveActivePermitWorkers(
  permitId: string,
  actorUserId: string,
): Promise<PermitActiveWorkerList> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitWorkerContextInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  const validityState = await resolveCurrentPermitValidity(permit.id, actorUserId);
  const validityStatus = validityState.currentValidity?.status ?? null;
  const contractorContextId = permitContractorContextId(permit);
  if (validityStatus === 'VALID') {
    await assertContractorContext({
      contractorContextType: permit.contractorContextType,
      contractorContextId,
      buildingId: permit.buildingId,
    }, actorUserId);
  }
  const workers = await permitWorkerRepository.list(
    { permitId: permit.id, status: 'ACTIVE' },
    [permit.buildingId],
  );
  const activeWorkers = validityStatus === 'VALID'
    ? workers.filter((worker) => workerIsEligible(worker)).map(toPublicPermitWorker)
    : [];
  return {
    permitId: permit.id,
    permitReference: permit.permitNumber,
    buildingId: permit.buildingId,
    contractorContextType: permit.contractorContextType,
    contractorVendorId: permit.contractorVendorId,
    validityStatus,
    active: validityStatus === 'VALID',
    workerCount: activeWorkers.length,
    workers: activeWorkers,
  };
}

async function recordWorkerEvent(
  worker: PermitWorkerRecord,
  actorUserId: string,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordOperationalEvent({
    clientId: worker.clientId,
    buildingId: worker.buildingId,
    entityType: 'PERMIT_WORKER',
    entityId: worker.id,
    eventType,
    actorUserId,
    summary,
    metadata: {
      permitId: worker.permitId,
      permitApplicationId: worker.permitApplicationId,
      contractorVendorId: worker.contractorVendorId,
      vendorWorkforceBindingId: worker.vendorWorkforceBindingId,
      ...metadata,
    },
  });
}

export const permitWorkerService = {
  addPermitWorker,
  deactivatePermitWorker,
  getPermitWorker,
  listPermitWorkers,
  listPermitWorkersForPermit,
  resolveActivePermitWorkers,
  toPublicPermitWorker,
  updatePermitWorker,
};

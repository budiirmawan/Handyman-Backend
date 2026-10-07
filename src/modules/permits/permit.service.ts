import { ERROR_CODES } from '../../shared/errors';
import { contractorContextService } from '../contractor-contexts/contractor-context.service';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import { permitWorkLifecycleRepository } from '../permit-work-lifecycle/permit-work-lifecycle.repository';
import { recordOperationalEvent } from '../operational-events';
import {
  permitCancelNotAllowedError,
  permitContextMismatchError,
  permitContractorInvalidError,
  permitNotFoundError,
  permitNumberAlreadyExistsError,
  permitUpdateNotAllowedError,
} from './permit.errors';
import { permitRepository } from './permit.repository';
import type {
  CreatePermitInput,
  NewPermit,
  PermitFilters,
  PermitRecord,
  PublicPermit,
  UpdatePermitInput,
} from './permit.types';

export function toPublicPermit(record: PermitRecord): PublicPermit {
  return {
    ...record,
    contractorContextId:
      record.tenantContractorRelationshipId ?? record.contractorVendorId,
    requestedAt: record.requestedAt.toISOString(),
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * BE-20A now delegates all Contractor identity and eligibility decisions to
 * the single BE-20B operational resolver. Permit-specific errors are retained
 * at this API boundary for backward compatibility with the foundation.
 */
async function resolvePermitContractorContext(
  input: CreatePermitInput,
  actorUserId: string,
) {
  try {
    return await contractorContextService.resolveContractorContext({
      contractorContextType: input.contractorContextType,
      contractorContextId: input.contractorContextId,
      buildingId: input.buildingId,
    }, actorUserId);
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? error.code
      : undefined;
    if (
      code === ERROR_CODES.CONTRACTOR_CONTEXT_INVALID ||
      code === ERROR_CODES.CONTRACTOR_CONTEXT_INACTIVE
    ) {
      throw permitContractorInvalidError();
    }
    if (
      code === ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_MISMATCH ||
      code === ERROR_CODES.CONTRACTOR_CONTEXT_BUILDING_REQUIRED
    ) {
      throw permitContextMismatchError();
    }
    throw error;
  }
}

function isPermitNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'permits_number_unique';
}

export async function createPermit(
  input: CreatePermitInput,
  actorUserId: string,
): Promise<PublicPermit> {
  const contractor = await resolvePermitContractorContext(input, actorUserId);
  if (
    await permitRepository.findByClientAndNumber(
      contractor.clientId,
      input.permitNumber,
    )
  ) {
    throw permitNumberAlreadyExistsError();
  }

  const newPermit: NewPermit = {
    clientId: contractor.clientId,
    buildingId: contractor.buildingId,
    permitNumber: input.permitNumber,
    permitType: input.permitType,
    title: input.title,
    workDescription: input.workDescription,
    applicantReference: input.applicantReference ?? null,
    contractorContextType: contractor.contractorContextType,
    contractorVendorId: contractor.vendorId,
    tenantContractorRelationshipId:
      contractor.tenantContractorRelationshipId,
    createdByUserId: actorUserId,
  };

  try {
    const created = await permitRepository.create(newPermit);
    await recordOperationalEvent({
      clientId: created.clientId,
      buildingId: created.buildingId,
      entityType: 'PERMIT',
      entityId: created.id,
      eventType: 'PERMIT_CREATED',
      actorUserId,
      summary: `Permit ${created.permitNumber} created`,
      metadata: {
        permitNumber: created.permitNumber,
        permitType: created.permitType,
        contractorContextType: created.contractorContextType,
        contractorVendorId: created.contractorVendorId,
      },
    });
    return toPublicPermit(created);
  } catch (error) {
    if (isPermitNumberUniqueViolation(error)) {
      throw permitNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getPermit(
  id: string,
  actorUserId: string,
): Promise<PublicPermit> {
  const record = await permitRepository.findById(id);
  if (!record) throw permitNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return toPublicPermit(record);
}

export async function listPermits(
  filters: PermitFilters,
  actorUserId: string,
): Promise<PublicPermit[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (await permitRepository.list(filters, buildingIds)).map(toPublicPermit);
}

export async function updatePermit(
  id: string,
  input: UpdatePermitInput,
  actorUserId: string,
): Promise<PublicPermit> {
  const existing = await permitRepository.findById(id);
  if (!existing) throw permitNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (
    existing.status !== 'DRAFT' ||
    await permitApplicationRepository.hasSubmittedForPermit(existing.id)
  ) {
    throw permitUpdateNotAllowedError();
  }

  const updated = await permitRepository.updateDraft(id, input);
  if (!updated) throw permitUpdateNotAllowedError();
  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    entityType: 'PERMIT',
    entityId: updated.id,
    eventType: 'PERMIT_UPDATED',
    actorUserId,
    summary: `Permit ${updated.permitNumber} metadata updated`,
    metadata: { fields: Object.keys(input) },
  });
  return toPublicPermit(updated);
}

export async function cancelPermit(
  id: string,
  actorUserId: string,
): Promise<PublicPermit> {
  const existing = await permitRepository.findById(id);
  if (!existing) throw permitNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (
    existing.status !== 'DRAFT' ||
    await permitWorkLifecycleRepository.findByPermitId(existing.id)
  ) {
    throw permitCancelNotAllowedError();
  }

  const cancelled = await permitRepository.cancelDraft(id, actorUserId);
  if (!cancelled) throw permitCancelNotAllowedError();
  await recordOperationalEvent({
    clientId: cancelled.clientId,
    buildingId: cancelled.buildingId,
    entityType: 'PERMIT',
    entityId: cancelled.id,
    eventType: 'PERMIT_CANCELLED',
    actorUserId,
    summary: `Permit ${cancelled.permitNumber} cancelled`,
    metadata: { previousStatus: existing.status },
  });
  return toPublicPermit(cancelled);
}

export const permitService = {
  cancelPermit,
  createPermit,
  getPermit,
  listPermits,
  toPublicPermit,
  updatePermit,
};

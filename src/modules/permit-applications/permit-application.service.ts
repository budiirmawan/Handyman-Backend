import { ERROR_CODES } from '../../shared/errors';
import { contractorContextService } from '../contractor-contexts/contractor-context.service';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permitRepository } from '../permits/permit.repository';
import type { PermitRecord } from '../permits/permit.types';
import { permitWorkLifecycleRepository } from '../permit-work-lifecycle/permit-work-lifecycle.repository';
import {
  permitApplicationAlreadyExistsError,
  permitApplicationCancelNotAllowedError,
  permitApplicationContractorInvalidError,
  permitApplicationInvalidWorkDateError,
  permitApplicationNotFoundError,
  permitApplicationPermitInvalidError,
  permitApplicationSubmitNotAllowedError,
  permitApplicationUpdateNotAllowedError,
} from './permit-application.errors';
import { permitApplicationRepository } from './permit-application.repository';
import type {
  CreatePermitApplicationInput,
  NewPermitApplication,
  PermitApplicationFilters,
  PermitApplicationRecord,
  PublicPermitApplication,
  UpdatePermitApplicationInput,
} from './permit-application.types';

export function toPublicPermitApplication(
  record: PermitApplicationRecord,
): PublicPermitApplication {
  return {
    ...record,
    requestedWorkAt: record.requestedWorkAt.toISOString(),
    submittedAt: record.submittedAt?.toISOString() ?? null,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function assertFutureWorkDate(requestedWorkAt: Date): void {
  const time = requestedWorkAt.getTime();
  if (Number.isNaN(time) || time <= Date.now()) {
    throw permitApplicationInvalidWorkDateError();
  }
}

function permitContractorContextId(permit: PermitRecord): string {
  return permit.tenantContractorRelationshipId ?? permit.contractorVendorId;
}

async function loadPermitForApplication(
  permitId: string,
  actorUserId: string,
): Promise<PermitRecord> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitApplicationPermitInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  if (permit.status !== 'DRAFT') {
    throw permitApplicationPermitInvalidError();
  }
  return permit;
}

async function validatePermitContractor(
  permit: PermitRecord,
  actorUserId: string,
): Promise<void> {
  try {
    await contractorContextService.validateContractorEligibilityForPermit({
      contractorContextType: permit.contractorContextType,
      contractorContextId: permitContractorContextId(permit),
      buildingId: permit.buildingId,
    }, actorUserId);
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
      throw permitApplicationContractorInvalidError();
    }
    throw error;
  }
}

function assertPermitAssertions(
  input: CreatePermitApplicationInput,
  permit: PermitRecord,
): void {
  if (
    input.applicantReference !== undefined &&
    input.applicantReference !== permit.applicantReference
  ) {
    throw permitApplicationPermitInvalidError();
  }
  if (
    input.workDescription !== undefined &&
    input.workDescription !== permit.workDescription
  ) {
    throw permitApplicationPermitInvalidError();
  }
  if (
    input.contractorContextType !== undefined &&
    input.contractorContextType !== permit.contractorContextType
  ) {
    throw permitApplicationContractorInvalidError();
  }
  if (
    input.contractorContextId !== undefined &&
    input.contractorContextId !== permitContractorContextId(permit)
  ) {
    throw permitApplicationContractorInvalidError();
  }
}

function isPermitApplicationUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'permit_applications_permit_unique';
}

export async function createPermitApplication(
  input: CreatePermitApplicationInput,
  actorUserId: string,
): Promise<PublicPermitApplication> {
  assertFutureWorkDate(input.requestedWorkAt);
  const permit = await loadPermitForApplication(input.permitId, actorUserId);
  assertPermitAssertions(input, permit);
  await validatePermitContractor(permit, actorUserId);
  if (await permitApplicationRepository.findByPermitId(permit.id)) {
    throw permitApplicationAlreadyExistsError();
  }

  const application: NewPermitApplication = {
    permitId: permit.id,
    requestedWorkAt: input.requestedWorkAt,
    notes: input.notes ?? null,
    createdByUserId: actorUserId,
  };
  try {
    const created = await permitApplicationRepository.create(application);
    await recordOperationalEvent({
      clientId: created.clientId,
      buildingId: created.buildingId,
      entityType: 'PERMIT_APPLICATION',
      entityId: created.id,
      eventType: 'PERMIT_APPLICATION_CREATED',
      actorUserId,
      summary: `Draft application created for Permit ${created.permitReference}`,
      metadata: {
        permitId: created.permitId,
        status: created.status,
        requestedWorkAt: created.requestedWorkAt.toISOString(),
        notes: created.notes,
      },
    });
    return toPublicPermitApplication(created);
  } catch (error) {
    if (isPermitApplicationUniqueViolation(error)) {
      throw permitApplicationAlreadyExistsError();
    }
    throw error;
  }
}

export async function getPermitApplication(
  id: string,
  actorUserId: string,
): Promise<PublicPermitApplication> {
  const application = await permitApplicationRepository.findById(id);
  if (!application) throw permitApplicationNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    application.buildingId,
  );
  return toPublicPermitApplication(application);
}

export async function listPermitApplications(
  filters: PermitApplicationFilters,
  actorUserId: string,
): Promise<PublicPermitApplication[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return (
    await permitApplicationRepository.list(filters, buildingIds)
  ).map(toPublicPermitApplication);
}

export async function updatePermitApplication(
  id: string,
  input: UpdatePermitApplicationInput,
  actorUserId: string,
): Promise<PublicPermitApplication> {
  const existing = await permitApplicationRepository.findById(id);
  if (!existing) throw permitApplicationNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.status !== 'DRAFT') {
    throw permitApplicationUpdateNotAllowedError();
  }
  if (input.requestedWorkAt) assertFutureWorkDate(input.requestedWorkAt);

  const updated = await permitApplicationRepository.updateDraft(id, input);
  if (!updated) throw permitApplicationUpdateNotAllowedError();
  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    entityType: 'PERMIT_APPLICATION',
    entityId: updated.id,
    eventType: 'PERMIT_APPLICATION_UPDATED',
    actorUserId,
    summary: `Draft application updated for Permit ${updated.permitReference}`,
    metadata: {
      before: {
        requestedWorkAt: existing.requestedWorkAt.toISOString(),
        notes: existing.notes,
      },
      after: {
        requestedWorkAt: updated.requestedWorkAt.toISOString(),
        notes: updated.notes,
      },
    },
  });
  return toPublicPermitApplication(updated);
}

export async function submitPermitApplication(
  id: string,
  actorUserId: string,
): Promise<PublicPermitApplication> {
  const existing = await permitApplicationRepository.findById(id);
  if (!existing) throw permitApplicationNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.status !== 'DRAFT') {
    throw permitApplicationSubmitNotAllowedError();
  }
  assertFutureWorkDate(existing.requestedWorkAt);
  const permit = await loadPermitForApplication(existing.permitId, actorUserId);
  await validatePermitContractor(permit, actorUserId);

  const submitted = await permitApplicationRepository.submitDraft(
    id,
    actorUserId,
  );
  if (!submitted) throw permitApplicationSubmitNotAllowedError();
  await recordOperationalEvent({
    clientId: submitted.clientId,
    buildingId: submitted.buildingId,
    entityType: 'PERMIT_APPLICATION',
    entityId: submitted.id,
    eventType: 'PERMIT_APPLICATION_SUBMITTED',
    actorUserId,
    summary: `Application submitted for Permit ${submitted.permitReference}`,
    metadata: {
      permitId: submitted.permitId,
      fromStatus: existing.status,
      toStatus: submitted.status,
      submittedAt: submitted.submittedAt?.toISOString() ?? null,
    },
  });
  return toPublicPermitApplication(submitted);
}

export async function cancelPermitApplication(
  id: string,
  actorUserId: string,
): Promise<PublicPermitApplication> {
  const existing = await permitApplicationRepository.findById(id);
  if (!existing) throw permitApplicationNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (
    !['DRAFT', 'SUBMITTED'].includes(existing.status) ||
    await permitWorkLifecycleRepository.findByPermitId(existing.permitId)
  ) {
    throw permitApplicationCancelNotAllowedError();
  }

  const cancelled = await permitApplicationRepository.cancel(id, actorUserId);
  if (!cancelled) throw permitApplicationCancelNotAllowedError();
  await recordOperationalEvent({
    clientId: cancelled.clientId,
    buildingId: cancelled.buildingId,
    entityType: 'PERMIT_APPLICATION',
    entityId: cancelled.id,
    eventType: 'PERMIT_APPLICATION_CANCELLED',
    actorUserId,
    summary: `Application cancelled for Permit ${cancelled.permitReference}`,
    metadata: {
      permitId: cancelled.permitId,
      fromStatus: existing.status,
      toStatus: cancelled.status,
      submittedAt: cancelled.submittedAt?.toISOString() ?? null,
    },
  });
  return toPublicPermitApplication(cancelled);
}

export const permitApplicationService = {
  cancelPermitApplication,
  createPermitApplication,
  getPermitApplication,
  listPermitApplications,
  submitPermitApplication,
  toPublicPermitApplication,
  updatePermitApplication,
};

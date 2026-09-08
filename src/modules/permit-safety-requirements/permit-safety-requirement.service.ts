import { AppError, ERROR_CODES } from '../../shared/errors';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { permitApplicationRepository } from '../permit-applications/permit-application.repository';
import type { PermitApplicationRecord } from '../permit-applications/permit-application.types';
import { permitWorkContextRepository } from '../permit-work-contexts/permit-work-context.repository';
import { permitRepository } from '../permits/permit.repository';
import {
  permitSafetyContextMismatchError,
  permitSafetyPermitInvalidError,
  permitSafetyPrerequisiteNotMetError,
  permitSafetyRequirementAlreadyExistsError,
  permitSafetyRequirementNotFoundError,
  permitSafetySharedControlInvalidError,
  permitSafetyUpdateNotAllowedError,
} from './permit-safety-requirement.errors';
import {
  permitSafetyRequirementRepository,
  type SharedChecklistExecution,
  type SharedChecklistTemplate,
  type SharedEvidenceRequirement,
} from './permit-safety-requirement.repository';
import type {
  CreatePermitSafetyRequirementInput,
  NewPermitSafetyRequirement,
  PermitSafetyReadiness,
  PermitSafetyReadinessStatus,
  PermitSafetyRequirementFilters,
  PermitSafetyRequirementRecord,
  PublicPermitSafetyRequirement,
  UpdatePermitSafetyReadinessInput,
} from './permit-safety-requirement.types';

type SharedControlState = {
  checklistTemplate: SharedChecklistTemplate | null;
  checklistExecution: SharedChecklistExecution | null;
  evidenceRequirement: SharedEvidenceRequirement | null;
  checklistStatus: string | null;
  checklistReady: boolean;
  evidenceReady: boolean | null;
};

function assertRequiredStatus(
  required: boolean,
  status: PermitSafetyReadinessStatus,
): void {
  if (
    (!required && status !== 'NOT_REQUIRED') ||
    (required && status === 'NOT_REQUIRED')
  ) {
    throw AppError.validation('Request validation failed.', [{
      field: 'readinessStatus',
      message: required
        ? 'A required Safety Requirement cannot be NOT_REQUIRED.'
        : 'A non-required Safety Requirement must be NOT_REQUIRED.',
    }]);
  }
}

async function loadApplicationContext(
  permitApplicationId: string,
  actorUserId: string,
): Promise<{
  application: PermitApplicationRecord;
  workType: string;
}> {
  const application = await permitApplicationRepository.findById(
    permitApplicationId,
  );
  if (!application) throw permitSafetyPermitInvalidError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    application.buildingId,
  );
  if (
    application.status === 'CANCELLED' ||
    application.permitStatus !== 'DRAFT'
  ) {
    throw permitSafetyUpdateNotAllowedError();
  }
  const workContext = await permitWorkContextRepository.findByApplicationId(
    application.id,
  );
  if (
    !workContext ||
    !workContext.workType ||
    !workContext.locationType ||
    !workContext.locationId
  ) {
    throw permitSafetyContextMismatchError();
  }
  return { application, workType: workContext.workType };
}

async function resolveApplicationIdForPermit(
  permitId: string,
  actorUserId: string,
): Promise<string> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitSafetyPermitInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  const application = await permitApplicationRepository.findByPermitId(permit.id);
  if (!application) throw permitSafetyPermitInvalidError();
  return application.id;
}

async function validateSharedControls(input: {
  clientId: string;
  checklistTemplateId: string | null;
  checklistExecutionId: string | null;
  evidenceRequirementId: string | null;
}): Promise<SharedControlState> {
  let checklistTemplate: SharedChecklistTemplate | null = null;
  let checklistExecution: SharedChecklistExecution | null = null;
  let evidenceRequirement: SharedEvidenceRequirement | null = null;

  if (input.checklistTemplateId) {
    checklistTemplate =
      await permitSafetyRequirementRepository.findChecklistTemplate(
        input.checklistTemplateId,
      );
    if (
      !checklistTemplate ||
      checklistTemplate.clientId !== input.clientId ||
      checklistTemplate.status !== 'ACTIVE'
    ) {
      throw permitSafetySharedControlInvalidError();
    }
  }

  if (input.checklistExecutionId) {
    checklistExecution =
      await permitSafetyRequirementRepository.findChecklistExecution(
        input.checklistExecutionId,
      );
    if (!checklistExecution || checklistExecution.clientId !== input.clientId) {
      throw permitSafetySharedControlInvalidError();
    }
    if (
      checklistTemplate &&
      checklistExecution.checklistTemplateId !== checklistTemplate.id
    ) {
      throw permitSafetySharedControlInvalidError();
    }
    if (!checklistTemplate) {
      checklistTemplate =
        await permitSafetyRequirementRepository.findChecklistTemplate(
          checklistExecution.checklistTemplateId,
        );
      if (
        !checklistTemplate ||
        checklistTemplate.clientId !== input.clientId ||
        checklistTemplate.status !== 'ACTIVE'
      ) {
        throw permitSafetySharedControlInvalidError();
      }
    }
  }

  if (input.evidenceRequirementId) {
    evidenceRequirement =
      await permitSafetyRequirementRepository.findEvidenceRequirement(
        input.evidenceRequirementId,
      );
    if (
      !evidenceRequirement ||
      evidenceRequirement.clientId !== input.clientId ||
      evidenceRequirement.status !== 'ACTIVE' ||
      !checklistTemplate ||
      !checklistExecution
    ) {
      throw permitSafetySharedControlInvalidError();
    }
    const evidenceTemplateId = evidenceRequirement.targetType === 'CHECKLIST_TEMPLATE'
      ? evidenceRequirement.targetId
      : evidenceRequirement.targetType === 'CHECKLIST_ITEM'
        ? await permitSafetyRequirementRepository.findChecklistItemTemplateId(
            evidenceRequirement.targetId,
          )
        : null;
    if (evidenceTemplateId !== checklistTemplate.id) {
      throw permitSafetySharedControlInvalidError();
    }
  }

  const checklistReady = checklistTemplate === null ||
    checklistExecution?.status === 'COMPLETED';
  const evidenceReady = evidenceRequirement === null
    ? null
    : (await permitSafetyRequirementRepository.countEvidence(
        evidenceRequirement.id,
        checklistExecution!.id,
      )) >= evidenceRequirement.minimumCount;
  return {
    checklistTemplate,
    checklistExecution,
    evidenceRequirement,
    checklistStatus: checklistExecution?.status ?? null,
    checklistReady,
    evidenceReady,
  };
}

async function resolvePublicRequirement(
  record: PermitSafetyRequirementRecord,
): Promise<PublicPermitSafetyRequirement> {
  let controls: SharedControlState;
  try {
    controls = await validateSharedControls({
      clientId: record.clientId,
      checklistTemplateId: record.checklistTemplateId,
      checklistExecutionId: record.checklistExecutionId,
      evidenceRequirementId: record.evidenceRequirementId,
    });
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      error.code !== ERROR_CODES.PERMIT_SAFETY_SHARED_CONTROL_INVALID
    ) {
      throw error;
    }
    controls = {
      checklistTemplate: null,
      checklistExecution: null,
      evidenceRequirement: null,
      checklistStatus: null,
      checklistReady: false,
      evidenceReady: record.evidenceRequirementId ? false : null,
    };
  }
  let resolvedReadinessStatus = record.readinessStatus;
  if (!record.required) {
    resolvedReadinessStatus = 'NOT_REQUIRED';
  } else if (
    record.currentWorkType !== record.workType ||
    (record.readinessStatus === 'READY' &&
      (!controls.checklistReady || controls.evidenceReady === false))
  ) {
    resolvedReadinessStatus = 'NOT_READY';
  }
  return {
    ...record,
    resolvedReadinessStatus,
    checklistStatus: controls.checklistStatus,
    evidenceReady: controls.evidenceReady,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function createForApplication(
  permitApplicationId: string,
  input: CreatePermitSafetyRequirementInput,
  actorUserId: string,
): Promise<PublicPermitSafetyRequirement> {
  const context = await loadApplicationContext(
    permitApplicationId,
    actorUserId,
  );
  if (
    input.buildingId !== context.application.buildingId ||
    input.workType !== context.workType
  ) {
    throw permitSafetyContextMismatchError();
  }
  const required = input.required ?? true;
  const readinessStatus = required
    ? input.readinessStatus ?? 'PENDING'
    : input.readinessStatus ?? 'NOT_REQUIRED';
  assertRequiredStatus(required, readinessStatus);

  const checklistTemplateId = input.checklistTemplateId ?? null;
  const checklistExecutionId = input.checklistExecutionId ?? null;
  const evidenceRequirementId = input.evidenceRequirementId ?? null;
  const controls = await validateSharedControls({
    clientId: context.application.clientId,
    checklistTemplateId,
    checklistExecutionId,
    evidenceRequirementId,
  });
  if (
    readinessStatus === 'READY' &&
    (!controls.checklistReady || controls.evidenceReady === false)
  ) {
    throw permitSafetyPrerequisiteNotMetError();
  }
  if (
    await permitSafetyRequirementRepository.findByApplicationAndType(
      context.application.id,
      input.requirementType,
    )
  ) {
    throw permitSafetyRequirementAlreadyExistsError();
  }

  const newRequirement: NewPermitSafetyRequirement = {
    permitApplicationId: context.application.id,
    workType: context.workType,
    requirementType: input.requirementType,
    requirementDescription: input.requirementDescription,
    required,
    readinessStatus,
    notes: input.notes ?? null,
    reference: input.reference ?? null,
    checklistTemplateId,
    checklistExecutionId,
    evidenceRequirementId,
    actorUserId,
  };
  try {
    const created = await permitSafetyRequirementRepository.create(newRequirement);
    await recordSafetyEvent(
      created,
      actorUserId,
      'PERMIT_SAFETY_REQUIREMENT_CREATED',
      'Permit Safety Requirement created',
      {
        requirementDescription: created.requirementDescription,
        required: created.required,
        readinessStatus: created.readinessStatus,
        notes: created.notes,
        reference: created.reference,
        checklistTemplateId: created.checklistTemplateId,
        checklistExecutionId: created.checklistExecutionId,
        evidenceRequirementId: created.evidenceRequirementId,
      },
    );
    return resolvePublicRequirement(created);
  } catch (error) {
    if (isUniqueViolation(error)) throw permitSafetyRequirementAlreadyExistsError();
    throw error;
  }
}

export async function createPermitSafetyRequirement(
  permitApplicationId: string,
  input: CreatePermitSafetyRequirementInput,
  actorUserId: string,
): Promise<PublicPermitSafetyRequirement> {
  return createForApplication(permitApplicationId, input, actorUserId);
}

export async function createPermitSafetyRequirementForPermit(
  permitId: string,
  input: CreatePermitSafetyRequirementInput,
  actorUserId: string,
): Promise<PublicPermitSafetyRequirement> {
  return createForApplication(
    await resolveApplicationIdForPermit(permitId, actorUserId),
    input,
    actorUserId,
  );
}

export async function getPermitSafetyRequirement(
  id: string,
  actorUserId: string,
): Promise<PublicPermitSafetyRequirement> {
  const record = await permitSafetyRequirementRepository.findById(id);
  if (!record) throw permitSafetyRequirementNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return resolvePublicRequirement(record);
}

export async function listPermitSafetyRequirements(
  filters: PermitSafetyRequirementFilters,
  actorUserId: string,
): Promise<PublicPermitSafetyRequirement[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  return Promise.all((
    await permitSafetyRequirementRepository.list(filters, buildingIds)
  ).map(resolvePublicRequirement));
}

export async function listPermitSafetyRequirementsForPermit(
  permitId: string,
  actorUserId: string,
): Promise<PublicPermitSafetyRequirement[]> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitSafetyPermitInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  return listPermitSafetyRequirements({ permitId }, actorUserId);
}

export async function listPermitSafetyRequirementsForApplication(
  permitApplicationId: string,
  actorUserId: string,
): Promise<PublicPermitSafetyRequirement[]> {
  const application = await permitApplicationRepository.findById(
    permitApplicationId,
  );
  if (!application) throw permitSafetyPermitInvalidError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    application.buildingId,
  );
  return listPermitSafetyRequirements({ permitApplicationId }, actorUserId);
}

export async function updatePermitSafetyReadiness(
  id: string,
  input: UpdatePermitSafetyReadinessInput,
  actorUserId: string,
): Promise<PublicPermitSafetyRequirement> {
  const existing = await permitSafetyRequirementRepository.findById(id);
  if (!existing) throw permitSafetyRequirementNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.applicationStatus === 'CANCELLED') {
    throw permitSafetyUpdateNotAllowedError();
  }
  assertRequiredStatus(existing.required, input.readinessStatus);

  const merged: UpdatePermitSafetyReadinessInput = {
    ...input,
    checklistTemplateId: input.checklistTemplateId === undefined
      ? existing.checklistTemplateId
      : input.checklistTemplateId,
    checklistExecutionId: input.checklistExecutionId === undefined
      ? existing.checklistExecutionId
      : input.checklistExecutionId,
    evidenceRequirementId: input.evidenceRequirementId === undefined
      ? existing.evidenceRequirementId
      : input.evidenceRequirementId,
  };
  const controls = await validateSharedControls({
    clientId: existing.clientId,
    checklistTemplateId: merged.checklistTemplateId ?? null,
    checklistExecutionId: merged.checklistExecutionId ?? null,
    evidenceRequirementId: merged.evidenceRequirementId ?? null,
  });
  if (
    input.readinessStatus === 'READY' &&
    (existing.currentWorkType !== existing.workType ||
      !controls.checklistReady ||
      controls.evidenceReady === false)
  ) {
    throw permitSafetyPrerequisiteNotMetError();
  }

  const updated = await permitSafetyRequirementRepository.updateReadiness(
    id,
    merged,
    actorUserId,
  );
  if (!updated) throw permitSafetyRequirementNotFoundError();
  await recordSafetyEvent(
    updated,
    actorUserId,
    'PERMIT_SAFETY_READINESS_UPDATED',
    'Permit Safety Requirement readiness updated',
    {
      before: {
        readinessStatus: existing.readinessStatus,
        notes: existing.notes,
        reference: existing.reference,
        checklistTemplateId: existing.checklistTemplateId,
        checklistExecutionId: existing.checklistExecutionId,
        evidenceRequirementId: existing.evidenceRequirementId,
      },
      after: {
        readinessStatus: updated.readinessStatus,
        notes: updated.notes,
        reference: updated.reference,
        checklistTemplateId: updated.checklistTemplateId,
        checklistExecutionId: updated.checklistExecutionId,
        evidenceRequirementId: updated.evidenceRequirementId,
      },
    },
  );
  return resolvePublicRequirement(updated);
}

export async function resolvePermitSafetyReadiness(
  permitId: string,
  actorUserId: string,
): Promise<PermitSafetyReadiness> {
  const permit = await permitRepository.findById(permitId);
  if (!permit) throw permitSafetyPermitInvalidError();
  await contextAccessService.assertBuildingAccess(actorUserId, permit.buildingId);
  const application = await permitApplicationRepository.findByPermitId(permit.id);
  if (!application) throw permitSafetyPermitInvalidError();
  const workContext = await permitWorkContextRepository.findByApplicationId(
    application.id,
  );
  const requirements = await listPermitSafetyRequirements(
    { permitId: permit.id },
    actorUserId,
  );
  const required = requirements.filter((item) => item.required);
  const ready = required.filter(
    (item) => item.resolvedReadinessStatus === 'READY',
  );
  const missingRequirementTypes = required
    .filter((item) => item.resolvedReadinessStatus !== 'READY')
    .map((item) => item.requirementType);
  let readinessStatus: PermitSafetyReadiness['readinessStatus'];
  if (requirements.length === 0) readinessStatus = 'NOT_CONFIGURED';
  else if (missingRequirementTypes.length === 0) readinessStatus = 'READY';
  else if (required.some(
    (item) => item.resolvedReadinessStatus === 'NOT_READY',
  )) readinessStatus = 'NOT_READY';
  else readinessStatus = 'PENDING';

  return {
    permitId: permit.id,
    permitApplicationId: application.id,
    permitReference: permit.permitNumber,
    buildingId: permit.buildingId,
    workType: workContext?.workType ?? null,
    ready: readinessStatus === 'READY',
    readinessStatus,
    requiredCount: required.length,
    readyCount: ready.length,
    missingRequirementTypes,
    requirements,
  };
}

async function recordSafetyEvent(
  requirement: PermitSafetyRequirementRecord,
  actorUserId: string,
  eventType: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordOperationalEvent({
    clientId: requirement.clientId,
    buildingId: requirement.buildingId,
    entityType: 'PERMIT_SAFETY_REQUIREMENT',
    entityId: requirement.id,
    eventType,
    actorUserId,
    summary,
    metadata: {
      permitId: requirement.permitId,
      permitApplicationId: requirement.permitApplicationId,
      requirementType: requirement.requirementType,
      workType: requirement.workType,
      ...metadata,
    },
  });
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' &&
    candidate.constraint === 'permit_safety_requirements_unique';
}

export const permitSafetyRequirementService = {
  createPermitSafetyRequirement,
  createPermitSafetyRequirementForPermit,
  getPermitSafetyRequirement,
  listPermitSafetyRequirements,
  listPermitSafetyRequirementsForApplication,
  listPermitSafetyRequirementsForPermit,
  resolvePermitSafetyReadiness,
  updatePermitSafetyReadiness,
};

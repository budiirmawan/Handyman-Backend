import { cleaningAreaRepository } from '../cleaning-areas';
import { dailyCleaningRepository } from '../daily-cleaning';
import { publicAreaInspectionRepository } from '../public-area-inspections';
import { toiletInspectionRepository } from '../toilet-inspections';
import {
  supervisorInspectionAlreadyOpenError,
  supervisorInspectionImmutableError,
  supervisorInspectionNotFoundError,
  supervisorInspectionTargetNotFoundError,
  supervisorInspectionTargetNotReviewableError,
} from './supervisor-inspection.errors';
import { supervisorInspectionRepository } from './supervisor-inspection.repository';
import type {
  CreateSupervisorInspectionInput,
  PublicSupervisorInspection,
  SubmitSupervisorDecisionInput,
  SupervisorInspectionFilter,
  SupervisorInspectionRecord,
  SupervisorInspectionTargetType,
} from './supervisor-inspection.types';

type ResolvedTarget = {
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  status: string;
  description: string;
};

async function resolveTarget(
  targetType: SupervisorInspectionTargetType,
  targetId: string,
): Promise<ResolvedTarget> {
  if (targetType === 'DAILY_CLEANING') {
    const task = await dailyCleaningRepository.findById(targetId);
    if (!task) {
      throw supervisorInspectionTargetNotFoundError();
    }
    if (!['IN_PROGRESS', 'COMPLETED'].includes(task.status)) {
      throw supervisorInspectionTargetNotReviewableError();
    }
    return {
      clientId: task.client_id,
      buildingId: task.building_id,
      cleaningAreaId: task.cleaning_area_id,
      status: task.status,
      description: `Daily cleaning task for ${task.cleaning_area_code}`,
    };
  }

  if (targetType === 'TOILET_INSPECTION') {
    const context = await toiletInspectionRepository.findExecutionContext(
      targetId,
    );
    if (!context) {
      throw supervisorInspectionTargetNotFoundError();
    }
    if (!['IN_PROGRESS', 'COMPLETED'].includes(context.execution_status)) {
      throw supervisorInspectionTargetNotReviewableError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      cleaningAreaId: context.cleaning_area_id,
      status: context.execution_status,
      description: `Toilet inspection for ${context.cleaning_area_code}`,
    };
  }

  if (targetType === 'PUBLIC_AREA_INSPECTION') {
    const context = await publicAreaInspectionRepository.findExecutionContext(
      targetId,
    );
    if (!context) {
      throw supervisorInspectionTargetNotFoundError();
    }
    if (!['IN_PROGRESS', 'COMPLETED'].includes(context.execution_status)) {
      throw supervisorInspectionTargetNotReviewableError();
    }
    return {
      clientId: context.client_id,
      buildingId: context.building_id,
      cleaningAreaId: context.cleaning_area_id,
      status: context.execution_status,
      description: `Public area inspection for ${context.cleaning_area_code}`,
    };
  }

  throw supervisorInspectionTargetNotFoundError();
}

export async function toPublicSupervisorInspection(
  record: SupervisorInspectionRecord,
): Promise<PublicSupervisorInspection> {
  const area = await cleaningAreaRepository.findById(record.cleaningAreaId);

  let targetSummary: { status: string; description: string } | null = null;
  try {
    const resolved = await resolveTarget(record.targetType, record.targetId);
    targetSummary = {
      status: resolved.status,
      description: resolved.description,
    };
  } catch {
    // Target may be deleted or archival
  }

  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    cleaningAreaId: record.cleaningAreaId,
    targetType: record.targetType,
    targetId: record.targetId,
    reviewId: record.reviewId,
    supervisorUserId: record.supervisorUserId,
    decision: record.decision,
    status: record.status,
    notes: record.notes,
    inspectedAt: record.inspectedAt ? record.inspectedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(area
      ? {
          cleaningArea: {
            id: area.id,
            code: area.code,
            name: area.name,
            cleaningAreaType: area.cleaningAreaType,
            status: area.status,
          },
        }
      : {}),
    targetSummary,
  };
}

export async function createSupervisorInspection(
  input: CreateSupervisorInspectionInput,
): Promise<PublicSupervisorInspection> {
  const target = await resolveTarget(input.targetType, input.targetId);

  const pending = await supervisorInspectionRepository.findPendingByTarget(
    input.targetType,
    input.targetId,
  );
  if (pending) {
    throw supervisorInspectionAlreadyOpenError();
  }

  let reviewId: string | null = null;
  if (
    input.targetType === 'TOILET_INSPECTION' ||
    input.targetType === 'PUBLIC_AREA_INSPECTION'
  ) {
    const sharedReview = await supervisorInspectionRepository.createSharedReview(
      {
        clientId: target.clientId,
        targetType: 'CHECKLIST_EXECUTION',
        targetId: input.targetId,
        reviewerUserId: input.supervisorUserId,
        notes: input.notes,
      },
    );
    reviewId = sharedReview.id;
  }

  const record = await supervisorInspectionRepository.create({
    clientId: target.clientId,
    buildingId: target.buildingId,
    cleaningAreaId: target.cleaningAreaId,
    targetType: input.targetType,
    targetId: input.targetId,
    reviewId,
    supervisorUserId: input.supervisorUserId,
    notes: input.notes,
  });

  return toPublicSupervisorInspection(record);
}

export async function getSupervisorInspectionById(
  id: string,
): Promise<PublicSupervisorInspection> {
  const record = await supervisorInspectionRepository.findById(id);
  if (!record) {
    throw supervisorInspectionNotFoundError();
  }
  return toPublicSupervisorInspection(record);
}

export async function listSupervisorInspections(
  filter: SupervisorInspectionFilter = {},
): Promise<PublicSupervisorInspection[]> {
  const records = await supervisorInspectionRepository.list(filter);
  return Promise.all(records.map(toPublicSupervisorInspection));
}

export async function submitSupervisorDecision(
  id: string,
  input: SubmitSupervisorDecisionInput,
): Promise<PublicSupervisorInspection> {
  const existing = await supervisorInspectionRepository.findById(id);
  if (!existing) {
    throw supervisorInspectionNotFoundError();
  }
  if (existing.status === 'COMPLETED') {
    throw supervisorInspectionImmutableError();
  }

  if (existing.reviewId) {
    await supervisorInspectionRepository.updateSharedReview(
      existing.reviewId,
      input.decision,
      input.notes,
    );
  }

  const record = await supervisorInspectionRepository.submitDecision(
    id,
    input.decision,
    input.notes,
  );
  return toPublicSupervisorInspection(record as SupervisorInspectionRecord);
}

export const supervisorInspectionService = {
  createSupervisorInspection,
  getSupervisorInspectionById,
  listSupervisorInspections,
  submitSupervisorDecision,
  toPublicSupervisorInspection,
};

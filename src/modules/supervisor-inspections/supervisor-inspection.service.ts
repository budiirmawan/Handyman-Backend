import { cleaningAreaRepository } from '../cleaning-areas';
import { contextAccessService } from '../context-access';
import {
  dailyCleaningNotFoundError,
  dailyCleaningRepository,
} from '../daily-cleaning';
import { permissionService } from '../permissions';
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
import {
  isSupervisorInspectionReviewableTargetStatus,
  type CreateSupervisorInspectionInput,
  type DailyCleaningSupervisorInspectionContext,
  type PublicSupervisorInspection,
  type SubmitSupervisorDecisionInput,
  type SupervisorInspectionFilter,
  type SupervisorInspectionMobileAction,
  type SupervisorInspectionRecord,
  type SupervisorInspectionTargetType,
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
    if (!isSupervisorInspectionReviewableTargetStatus(task.status)) {
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
    if (!isSupervisorInspectionReviewableTargetStatus(context.execution_status)) {
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
    if (!isSupervisorInspectionReviewableTargetStatus(context.execution_status)) {
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

  // DEF-J05-F-01 — Building authority is asserted against the target-derived
  // authoritative Building BEFORE any mutation (shared review / inspection
  // insert). The controller retains its post-create check as defense-in-depth.
  await contextAccessService.assertBuildingAccess(
    input.supervisorUserId,
    target.buildingId,
  );

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

/**
 * CR-BE-RN14-CLEANING-SUPERVISOR-MOBILE-01 — backend-only command authority.
 *
 *   CREATE_INSPECTION — no PENDING inspection, the target is still
 *                       reviewable, and the caller may manage inspections;
 *   SUBMIT_DECISION   — a PENDING inspection exists and the caller may
 *                       manage inspections.
 *
 * Building access is asserted by the caller before this resolver runs, so
 * reaching it already proves the Building condition. The list is therefore
 * driven purely by live inspection state × the manage permission; mobile
 * never derives these tokens.
 */
export function resolveDailyCleaningSupervisorInspectionActions(input: {
  hasPendingInspection: boolean;
  targetReviewable: boolean;
  canManage: boolean;
}): SupervisorInspectionMobileAction[] {
  if (!input.canManage) {
    return [];
  }
  if (input.hasPendingInspection) {
    return ['SUBMIT_DECISION'];
  }
  return input.targetReviewable ? ['CREATE_INSPECTION'] : [];
}

/**
 * Target-scoped discovery of the DAILY_CLEANING supervisor inspection for a
 * Daily Cleaning task, so mobile never scans the global inspection list.
 *
 * `taskId` is resolved canonically through Daily Cleaning (the same
 * authoritative reading BE-11C publishes as `id` / `taskId`, i.e.
 * `generated_tasks.id`) — no second task lookup is introduced. The Building
 * authority check runs against the target-derived Building before any
 * inspection fact is disclosed, so an unrelated-Building caller is denied
 * rather than shown `inspection: null`.
 */
export async function getDailyCleaningSupervisorInspectionContext(
  taskId: string,
  actorUserId: string,
): Promise<DailyCleaningSupervisorInspectionContext> {
  const task = await dailyCleaningRepository.findById(taskId);
  if (!task) {
    throw dailyCleaningNotFoundError();
  }

  await contextAccessService.assertBuildingAccess(
    actorUserId,
    task.building_id,
  );

  const pending = await supervisorInspectionRepository.findPendingByTarget(
    'DAILY_CLEANING',
    taskId,
  );

  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );

  return {
    inspection: pending ? await toPublicSupervisorInspection(pending) : null,
    availableActions: resolveDailyCleaningSupervisorInspectionActions({
      hasPendingInspection: pending !== null,
      targetReviewable: isSupervisorInspectionReviewableTargetStatus(task.status),
      canManage: permissions.has('supervisor_inspection.manage'),
    }),
  };
}

export const supervisorInspectionService = {
  createSupervisorInspection,
  getDailyCleaningSupervisorInspectionContext,
  getSupervisorInspectionById,
  listSupervisorInspections,
  resolveDailyCleaningSupervisorInspectionActions,
  submitSupervisorDecision,
  toPublicSupervisorInspection,
};

import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { mobileFormInstanceService } from './mobile-form-instance.service';
import type { FormInstanceRow } from '../form-instances';

function toBoundInstanceReference(row: FormInstanceRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    formTemplateVersionId: row.form_template_version_id,
    generatedTaskId: row.generated_task_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    completedByUserId: row.completed_by_user_id ?? null,
    assigneeType: row.assignee_type ?? null,
    assignedWorkforceProfileId: row.assigned_workforce_profile_id ?? null,
    assignedTeamId: row.assigned_team_id ?? null,
    assignmentSnapshotAt: row.assignment_snapshot_at ?? null,
  };
}

/**
 * MOB-C07 PART 02 — Open (get-or-create) the bound Form Instance for an
 * assigned, current-shift FORM_VERSION generated task. Authority is derived
 * server-side from `:taskId`; the request body is ignored.
 */
export async function openMobileFormInstanceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const taskId = Array.isArray(req.params.taskId) ? '' : req.params.taskId;
    const row = await mobileFormInstanceService.openFormInstanceForTask(
      taskId,
      req.auth.userId,
    );
    sendSuccess(res, toBoundInstanceReference(row));
  } catch (error) {
    next(error);
  }
}

/**
 * MOB-C07 PART 03 — Start a bound Form Instance (DRAFT → IN_PROGRESS).
 * Re-checks assignment / shift / Building / version / parent / task status
 * before composing PART 01A `startFormInstance`. Body ids are never authority.
 */
export async function startMobileFormInstanceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const instanceId = Array.isArray(req.params.instanceId)
      ? ''
      : req.params.instanceId;
    const row = await mobileFormInstanceService.startMobileFormInstance(
      instanceId,
      req.auth.userId,
    );
    sendSuccess(res, toBoundInstanceReference(row));
  } catch (error) {
    next(error);
  }
}

/**
 * MOB-C07 PART 03 — Save responses on a bound Form Instance. Payload
 * semantics match the generic PUT (object or array of `{ fieldId, value }`).
 * Re-checks bound-instance authority, then composes PART 01A
 * `saveFormResponses`. Returns the same empty payload.
 */
export async function saveMobileFormResponsesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const instanceId = Array.isArray(req.params.instanceId)
      ? ''
      : req.params.instanceId;
    await mobileFormInstanceService.saveMobileFormResponses(
      instanceId,
      req.auth.userId,
      req.body,
    );
    sendSuccess(res, {});
  } catch (error) {
    next(error);
  }
}

/**
 * MOB-C07 PART 04 — Complete or cancel a bound Form Instance. Re-checks
 * bound-instance authority, then composes PART 01A `finishFormInstance`.
 * Does not mutate the generated task. Body ids are never authority.
 */
export async function finishMobileFormInstanceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const instanceId = Array.isArray(req.params.instanceId)
      ? ''
      : req.params.instanceId;
    const action = req.path.endsWith('cancel') ? 'cancel' : 'complete';
    const row = await mobileFormInstanceService.finishMobileFormInstance(
      instanceId,
      req.auth.userId,
      action,
    );
    sendSuccess(res, toBoundInstanceReference(row));
  } catch (error) {
    next(error);
  }
}

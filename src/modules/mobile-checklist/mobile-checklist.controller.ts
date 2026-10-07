import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { parseCreateMobileFindingBody } from './mobile-checklist-finding.validation';
import { mobileChecklistService } from './mobile-checklist.service';
import type { ChecklistExecutionRow } from '../checklist-executions';

/**
 * BE-25D — Mobile checklist execution handler.
 *
 *   GET /mobile/checklist-executions/:executionId
 *
 * Requires `checklist.read`; the execution's Client must be inside the
 * caller's accessible scope (BE-02G, enforced in the service).
 */
export async function getMobileChecklistExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionId = Array.isArray(req.params.executionId)
      ? ''
      : req.params.executionId;
    const execution = await mobileChecklistService.getMobileChecklistExecution(
      executionId,
      req.auth.userId,
    );
    sendSuccess(res, execution);
  } catch (error) {
    next(error);
  }
}

/** MOB-C04 PART 02 — minimal execution-row response for mobile mutations. */
function toExecutionOutput(row: ChecklistExecutionRow): Record<string, unknown> {
  return {
    id: row.id,
    clientId: row.client_id,
    checklistTemplateId: row.checklist_template_id,
    status: row.status,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * MOB-C04 PART 02 — Mobile online checklist execution handlers. Each mutation
 * is gated by the authoritative current-shift Building authority (enforced in
 * the service) and then delegates to the SAME shared checklist-execution
 * service as the generic REST endpoints — lifecycle and scope are never
 * re-implemented. Requires `checklist.manage` (the existing execution
 * authority).
 */
export async function startMobileChecklistExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionId = Array.isArray(req.params.executionId)
      ? ''
      : req.params.executionId;
    const row = await mobileChecklistService.executeMobileChecklistStart(
      executionId,
      req.auth.userId,
    );
    sendSuccess(res, toExecutionOutput(row));
  } catch (error) {
    next(error);
  }
}

export async function saveMobileChecklistResponsesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionId = Array.isArray(req.params.executionId)
      ? ''
      : req.params.executionId;
    await mobileChecklistService.executeMobileChecklistResponses(
      executionId,
      req.auth.userId,
      req.body,
    );
    sendSuccess(res, {});
  } catch (error) {
    next(error);
  }
}

export async function finishMobileChecklistExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionId = Array.isArray(req.params.executionId)
      ? ''
      : req.params.executionId;
    const action = req.path.endsWith('cancel') ? 'cancel' : 'complete';
    const row = await mobileChecklistService.executeMobileChecklistFinish(
      executionId,
      req.auth.userId,
      action,
    );
    sendSuccess(res, toExecutionOutput(row));
  } catch (error) {
    next(error);
  }
}

/**
 * MOB-C04 PART 02B — Open (get-or-create) the bound checklist execution for an
 * assigned, current-shift generated task. Returns the minimum execution
 * reference needed to continue (executionId, generatedTaskId,
 * checklistTemplateId, clientId, status). Authority is derived server-side
 * from the generated task — no client-selected template/building/shift. The
 * worker then drives start/responses/complete/cancel via the shift-locked
 * mobile commands (and reads full content via the BE-25D read model).
 */
/**
 * MOB-C05 PART 03 — Report a Finding from an authoritative bound checklist
 * execution. Body is strictly title + optional description only; every
 * authoritative context field (clientId/buildingId/findingNumber/source/
 * shift/task/….) is derived server-side. The service enforces the C04
 * current-shift + task-assignment + BE-02G authority chain and atomically
 * creates the Finding with its CHECKLIST_EXECUTION source binding.
 */
export async function createMobileChecklistFindingHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionId = Array.isArray(req.params.executionId)
      ? ''
      : req.params.executionId;
    const input = parseCreateMobileFindingBody(req.body);
    const result = await mobileChecklistService.createMobileChecklistFinding(
      executionId,
      req.auth.userId,
      input,
    );
    sendSuccess(res, result, 201);
  } catch (error) {
    next(error);
  }
}

export async function openMobileChecklistExecutionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const taskId = Array.isArray(req.params.taskId) ? '' : req.params.taskId;
    const row = await mobileChecklistService.openChecklistExecutionForTask(
      taskId,
      req.auth.userId,
    );
    sendSuccess(res, {
      executionId: row.id,
      generatedTaskId: row.generated_task_id,
      checklistTemplateId: row.checklist_template_id,
      clientId: row.client_id,
      status: row.status,
    });
  } catch (error) {
    next(error);
  }
}

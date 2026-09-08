import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { mobileChecklistService } from './mobile-checklist.service';

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

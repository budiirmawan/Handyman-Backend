import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { findingService, parseFindingIdParam } from '../findings';
import { assertFindingActionAllowed } from '../findings/finding-action.authority';
import { findingReworkService } from './finding-rework.service';
import {
  parseFindingReasonBody,
  parseFindingReworkNotesBody,
} from './finding-rework.validation';

const param = (value: string | string[]) => Array.isArray(value) ? '' : value;
async function authorized(req: Request) {
  if (!req.auth) throw authenticationRequiredError();
  const findingId = parseFindingIdParam(param(req.params.id));
  const finding = await findingService.getFindingById(findingId);
  await contextAccessService.assertBuildingAccess(req.auth.userId, finding.buildingId);
  return { findingId, userId: req.auth.userId };
}
export async function rejectFindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    await assertFindingActionAllowed(context.findingId, context.userId, 'REJECT');
    sendSuccess(res, await findingReworkService.rejectFinding({
      ...context, ...parseFindingReasonBody(req.body),
    }), 201);
  } catch (error) { next(error); }
}
export async function requestFindingReworkHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    await assertFindingActionAllowed(
      context.findingId,
      context.userId,
      'REQUEST_REWORK',
    );
    sendSuccess(res, await findingReworkService.requestFindingRework({
      ...context, ...parseFindingReasonBody(req.body),
    }), 201);
  } catch (error) { next(error); }
}
export async function getFindingReworkHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    sendSuccess(res, await findingReworkService.getFindingReworkContext(context.findingId));
  } catch (error) { next(error); }
}
export async function updateFindingReworkNotesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    await assertFindingActionAllowed(context.findingId, context.userId, 'RESUBMIT');
    sendSuccess(res, await findingReworkService.updateFindingReworkNotes({
      ...context, ...parseFindingReworkNotesBody(req.body),
    }));
  } catch (error) { next(error); }
}
export async function resubmitFindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    await assertFindingActionAllowed(context.findingId, context.userId, 'RESUBMIT');
    sendSuccess(res, await findingReworkService.resubmitFinding({
      ...context, ...parseFindingReworkNotesBody(req.body),
    }));
  } catch (error) { next(error); }
}

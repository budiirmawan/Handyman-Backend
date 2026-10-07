import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { contextAccessService } from '../context-access';
import { findingService, parseFindingIdParam } from '../findings';
import { assertFindingActionAllowed } from '../findings/finding-action.authority';
import { findingClosureService } from './finding-closure.service';
import { parseCloseFindingBody } from './finding-closure.validation';

const param = (value: string | string[]) => Array.isArray(value) ? '' : value;
async function authorized(req: Request) {
  if (!req.auth) throw authenticationRequiredError();
  const findingId = parseFindingIdParam(param(req.params.id));
  const finding = await findingService.getFindingById(findingId);
  await contextAccessService.assertBuildingAccess(req.auth.userId, finding.buildingId);
  return { findingId, userId: req.auth.userId };
}
export async function getFindingClosureHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    sendSuccess(res, await findingClosureService.getFindingClosureInfo(context.findingId));
  } catch (error) { next(error); }
}
export async function closeFindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await authorized(req);
    await assertFindingActionAllowed(context.findingId, context.userId, 'CLOSE');
    sendSuccess(res, await findingClosureService.closeFinding({
      findingId: context.findingId,
      closedByUserId: context.userId,
      ...parseCloseFindingBody(req.body),
    }));
  } catch (error) { next(error); }
}

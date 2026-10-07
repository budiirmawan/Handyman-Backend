import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { findingSeverityService } from './finding-severity.service';
import { parseCreateFindingSeverityBody, parseFindingSeverityClientIdParam, parseFindingSeverityIdParam, parseUpdateFindingSeverityBody } from './finding-severity.validation';

const param = (value: string | string[]) => Array.isArray(value) ? '' : value;
async function assertClient(req: Request, clientId: string): Promise<void> {
  if (!req.auth) throw authenticationRequiredError();
  if (!(await contextAccessService.canAccessClient(req.auth.userId, clientId))) throw buildingAccessDeniedError();
}
export async function createFindingSeverityHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseFindingSeverityClientIdParam(param(req.params.clientId)); await assertClient(req, clientId);
    sendSuccess(res, await findingSeverityService.createFindingSeverity({ ...parseCreateFindingSeverityBody(req.body), clientId }), 201);
  } catch (error) { next(error); }
}
export async function listFindingSeveritiesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseFindingSeverityClientIdParam(param(req.params.clientId)); await assertClient(req, clientId);
    sendSuccess(res, await findingSeverityService.listFindingSeveritiesByClient(clientId));
  } catch (error) { next(error); }
}
async function authorized(req: Request) {
  const item = await findingSeverityService.getFindingSeverityById(parseFindingSeverityIdParam(param(req.params.id)));
  await assertClient(req, item.clientId); return item;
}
export async function getFindingSeverityHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await authorized(req)); } catch (error) { next(error); }
}
export async function updateFindingSeverityHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const item = await authorized(req);
    sendSuccess(res, await findingSeverityService.updateFindingSeverity(item.id, parseUpdateFindingSeverityBody(req.body)));
  } catch (error) { next(error); }
}

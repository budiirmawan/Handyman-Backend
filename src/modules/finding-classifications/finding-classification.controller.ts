import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { findingClassificationService } from './finding-classification.service';
import {
  parseCreateFindingClassificationBody,
  parseFindingClassificationClientIdParam,
  parseFindingClassificationIdParam,
  parseUpdateFindingClassificationBody,
} from './finding-classification.validation';

const param = (value: string | string[]) => Array.isArray(value) ? '' : value;
async function assertClient(req: Request, clientId: string): Promise<void> {
  if (!req.auth) throw authenticationRequiredError();
  if (!(await contextAccessService.canAccessClient(req.auth.userId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

export async function createFindingClassificationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseFindingClassificationClientIdParam(param(req.params.clientId));
    await assertClient(req, clientId);
    const result = await findingClassificationService.createFindingClassification({
      ...parseCreateFindingClassificationBody(req.body), clientId,
    });
    sendSuccess(res, result, 201);
  } catch (error) { next(error); }
}

export async function listFindingClassificationsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const clientId = parseFindingClassificationClientIdParam(param(req.params.clientId));
    await assertClient(req, clientId);
    sendSuccess(res, await findingClassificationService.listFindingClassificationsByClient(clientId));
  } catch (error) { next(error); }
}

async function authorized(req: Request) {
  const id = parseFindingClassificationIdParam(param(req.params.id));
  const item = await findingClassificationService.getFindingClassificationById(id);
  await assertClient(req, item.clientId);
  return item;
}

export async function getFindingClassificationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try { sendSuccess(res, await authorized(req)); } catch (error) { next(error); }
}

export async function updateFindingClassificationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const item = await authorized(req);
    sendSuccess(res, await findingClassificationService.updateFindingClassification(
      item.id, parseUpdateFindingClassificationBody(req.body),
    ));
  } catch (error) { next(error); }
}

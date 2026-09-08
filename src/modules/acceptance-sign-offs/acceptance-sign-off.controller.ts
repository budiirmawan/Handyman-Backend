import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { acceptanceSignOffService } from './acceptance-sign-off.service';
import { parseAcceptanceSignOffFilters, parseAcceptanceSignOffIdParam, parseCreateAcceptanceSignOffBody } from './acceptance-sign-off.validation';

function paramString(v: string | string[]): string { return Array.isArray(v) ? '' : v; }

export async function submitAcceptanceSignOffHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const body = parseCreateAcceptanceSignOffBody(req.body);
    const signOff = await acceptanceSignOffService.submitAcceptanceSignOff(body, req.auth.userId);
    sendSuccess(res, signOff, 201);
  } catch (error) { next(error); }
}
export async function getAcceptanceSignOffHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseAcceptanceSignOffIdParam(paramString(req.params.id));
    const signOff = await acceptanceSignOffService.getAcceptanceSignOff(id, req.auth.userId);
    sendSuccess(res, signOff);
  } catch (error) { next(error); }
}
export async function listAcceptanceSignOffsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseAcceptanceSignOffFilters(req.query as Record<string, unknown>);
    const signOffs = await acceptanceSignOffService.listAcceptanceSignOffs(filters, req.auth.userId);
    sendSuccess(res, signOffs);
  } catch (error) { next(error); }
}

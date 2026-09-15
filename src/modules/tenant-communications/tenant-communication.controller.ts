import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantCommunicationService } from './tenant-communication.service';
import {
  parseCreateTenantCommunicationBody,
  parseTenantCommunicationCompanyIdParam,
  parseTenantCommunicationFilters,
  parseTenantCommunicationIdParam,
  parseUpdateTenantCommunicationBody,
} from './tenant-communication.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createTenantCommunicationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantCompanyId = parseTenantCommunicationCompanyIdParam(param(req.params.tenantCompanyId));
    sendSuccess(res, await tenantCommunicationService.createTenantCommunication(
      { ...parseCreateTenantCommunicationBody(req.body), tenantCompanyId }, actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getTenantCommunicationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantCommunicationService.getTenantCommunication(
      parseTenantCommunicationIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listTenantCommunicationsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantCommunicationService.listTenantCommunications(
      parseTenantCommunicationCompanyIdParam(param(req.params.tenantCompanyId)),
      parseTenantCommunicationFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function updateTenantCommunicationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantCommunicationService.updateTenantCommunicationDraft(
      parseTenantCommunicationIdParam(param(req.params.id)),
      parseUpdateTenantCommunicationBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function sendTenantCommunicationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantCommunicationService.sendTenantCommunication(
      parseTenantCommunicationIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function readTenantCommunicationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantCommunicationService.readTenantCommunication(
      parseTenantCommunicationIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}

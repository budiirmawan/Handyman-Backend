import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantUtilityRequestService } from './tenant-utility-request.service';
import {
  parseCreateTenantUtilityRequestBody,
  parseCreateUtilityRequestWorkOrderBody,
  parseTenantUtilityRequestBuildingIdParam,
  parseTenantUtilityRequestCompanyIdParam,
  parseTenantUtilityRequestFilters,
  parseTenantUtilityRequestIdParam,
  parseUpdateTenantUtilityRequestBody,
} from './tenant-utility-request.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createTenantUtilityRequestHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantCompanyId = parseTenantUtilityRequestCompanyIdParam(param(req.params.tenantCompanyId));
    sendSuccess(res, await tenantUtilityRequestService.createTenantUtilityRequest(
      { ...parseCreateTenantUtilityRequestBody(req.body), tenantCompanyId }, actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getTenantUtilityRequestHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantUtilityRequestService.getTenantUtilityRequest(
      parseTenantUtilityRequestIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listTenantUtilityRequestsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantUtilityRequestService.listTenantUtilityRequests(
      parseTenantUtilityRequestCompanyIdParam(param(req.params.tenantCompanyId)),
      parseTenantUtilityRequestFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listBuildingUtilityRequestsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantUtilityRequestService.listBuildingUtilityRequests(
      parseTenantUtilityRequestBuildingIdParam(param(req.params.buildingId)),
      parseTenantUtilityRequestFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function updateTenantUtilityRequestHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantUtilityRequestService.updateTenantUtilityRequest(
      parseTenantUtilityRequestIdParam(param(req.params.id)),
      parseUpdateTenantUtilityRequestBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function cancelTenantUtilityRequestHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantUtilityRequestService.cancelTenantUtilityRequest(
      parseTenantUtilityRequestIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function getTenantUtilityRequestActionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantUtilityRequestService.resolveTenantUtilityRequestAvailableActions(
      parseTenantUtilityRequestIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function createUtilityWorkRequestHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantUtilityRequestService.createWorkRequestForTenantUtilityRequest(
      parseTenantUtilityRequestIdParam(param(req.params.id)), actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function createUtilityWorkOrderHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantUtilityRequestService.createWorkOrderForTenantUtilityRequest(
      parseTenantUtilityRequestIdParam(param(req.params.id)),
      parseCreateUtilityRequestWorkOrderBody(req.body), actor(req),
    ), 201);
  } catch (error) { next(error); }
}

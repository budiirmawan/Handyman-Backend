import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantComplaintService } from './tenant-complaint.service';
import {
  parseCreateComplaintWorkOrderBody,
  parseCreateTenantComplaintBody,
  parseTenantComplaintBuildingIdParam,
  parseTenantComplaintCompanyIdParam,
  parseTenantComplaintFilters,
  parseTenantComplaintIdParam,
  parseUpdateTenantComplaintBody,
} from './tenant-complaint.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createTenantComplaintHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantCompanyId = parseTenantComplaintCompanyIdParam(param(req.params.tenantCompanyId));
    const body = parseCreateTenantComplaintBody(req.body);
    sendSuccess(res, await tenantComplaintService.createTenantComplaint(
      { ...body, tenantCompanyId }, actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getTenantComplaintHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseTenantComplaintIdParam(param(req.params.id));
    sendSuccess(res, await tenantComplaintService.getTenantComplaint(id, actor(req)));
  } catch (error) { next(error); }
}
export async function listTenantComplaintsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantCompanyId = parseTenantComplaintCompanyIdParam(param(req.params.tenantCompanyId));
    sendSuccess(res, await tenantComplaintService.listTenantComplaints(
      tenantCompanyId, parseTenantComplaintFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listBuildingComplaintsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const buildingId = parseTenantComplaintBuildingIdParam(param(req.params.buildingId));
    sendSuccess(res, await tenantComplaintService.listBuildingComplaints(
      buildingId, parseTenantComplaintFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function updateTenantComplaintHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseTenantComplaintIdParam(param(req.params.id));
    sendSuccess(res, await tenantComplaintService.updateTenantComplaint(
      id, parseUpdateTenantComplaintBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function cancelTenantComplaintHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseTenantComplaintIdParam(param(req.params.id));
    sendSuccess(res, await tenantComplaintService.cancelTenantComplaint(id, actor(req)));
  } catch (error) { next(error); }
}
export async function getTenantComplaintActionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseTenantComplaintIdParam(param(req.params.id));
    sendSuccess(res, await tenantComplaintService.resolveTenantComplaintAvailableActions(id, actor(req)));
  } catch (error) { next(error); }
}
export async function createComplaintFindingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseTenantComplaintIdParam(param(req.params.id));
    sendSuccess(res, await tenantComplaintService.createFindingForTenantComplaint(id, actor(req)), 201);
  } catch (error) { next(error); }
}
export async function createComplaintWorkOrderHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = parseTenantComplaintIdParam(param(req.params.id));
    sendSuccess(res, await tenantComplaintService.createWorkOrderForTenantComplaint(
      id, parseCreateComplaintWorkOrderBody(req.body), actor(req),
    ), 201);
  } catch (error) { next(error); }
}

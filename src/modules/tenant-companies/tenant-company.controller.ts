import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantCompanyService } from './tenant-company.service';
import {
  parseCreateTenantCompanyBody,
  parseTenantCompanyClientIdParam,
  parseTenantCompanyIdParam,
  parseTenantCompanyListQuery,
  parseUpdateTenantCompanyBody,
} from './tenant-company.validation';

const param = (value: string | string[] | undefined): string => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');

export async function createTenantCompanyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const clientId = parseTenantCompanyClientIdParam(param(req.params.clientId));
    const body = parseCreateTenantCompanyBody(req.body);
    sendSuccess(res, await tenantCompanyService.createTenantCompany({ ...body, clientId }, req.auth.userId), 201);
  } catch (error) { next(error); }
}
export async function listTenantCompaniesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const clientId = parseTenantCompanyClientIdParam(param(req.params.clientId));
    const filters = parseTenantCompanyListQuery(req.query as Record<string, unknown>);
    sendSuccess(res, await tenantCompanyService.listTenantCompanies(clientId, filters, req.auth.userId));
  } catch (error) { next(error); }
}
export async function getTenantCompanyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseTenantCompanyIdParam(param(req.params.id));
    sendSuccess(res, await tenantCompanyService.getTenantCompany(id, req.auth.userId));
  } catch (error) { next(error); }
}
export async function updateTenantCompanyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseTenantCompanyIdParam(param(req.params.id));
    const body = parseUpdateTenantCompanyBody(req.body);
    sendSuccess(res, await tenantCompanyService.updateTenantCompany(id, body, req.auth.userId));
  } catch (error) { next(error); }
}

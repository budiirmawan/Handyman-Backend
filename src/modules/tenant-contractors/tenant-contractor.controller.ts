import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantContractorService } from './tenant-contractor.service';
import {
  parseCreateTenantContractorBody,
  parseTenantContractorBuildingIdParam,
  parseTenantContractorCompanyIdParam,
  parseTenantContractorFilters,
  parseTenantContractorIdParam,
  parseTenantContractorVendorIdParam,
  parseUpdateTenantContractorBody,
} from './tenant-contractor.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createTenantContractorHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantCompanyId = parseTenantContractorCompanyIdParam(param(req.params.tenantCompanyId));
    sendSuccess(res, await tenantContractorService.createTenantContractorRelationship(
      { ...parseCreateTenantContractorBody(req.body), tenantCompanyId }, actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getTenantContractorHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantContractorService.getTenantContractorRelationship(
      parseTenantContractorIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listTenantContractorsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantContractorService.listTenantContractorRelationships(
      parseTenantContractorCompanyIdParam(param(req.params.tenantCompanyId)),
      parseTenantContractorFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listBuildingContractorsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantContractorService.listBuildingContractorRelationships(
      parseTenantContractorBuildingIdParam(param(req.params.buildingId)),
      parseTenantContractorFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listContractorTenantsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantContractorService.listContractorTenantRelationships(
      parseTenantContractorVendorIdParam(param(req.params.vendorId)),
      parseTenantContractorFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function updateTenantContractorHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantContractorService.updateTenantContractorRelationship(
      parseTenantContractorIdParam(param(req.params.id)),
      parseUpdateTenantContractorBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}

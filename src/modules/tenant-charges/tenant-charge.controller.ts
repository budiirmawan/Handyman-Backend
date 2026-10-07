import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantChargeService } from './tenant-charge.service';
import {
  parseCancelTenantChargeBody,
  parseCreateTenantChargeBody,
  parseTenantChargeCompanyIdParam,
  parseTenantChargeFilters,
  parseTenantChargeIdParam,
  parseUpdateTenantChargeBody,
} from './tenant-charge.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createTenantChargeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantCompanyId = parseTenantChargeCompanyIdParam(param(req.params.tenantCompanyId));
    sendSuccess(res, await tenantChargeService.createTenantCharge(
      { ...parseCreateTenantChargeBody(req.body), tenantCompanyId }, actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getTenantChargeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantChargeService.getTenantCharge(
      parseTenantChargeIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listTenantChargesHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantChargeService.listTenantCharges(
      parseTenantChargeFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function updateTenantChargeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantChargeService.updateTenantCharge(
      parseTenantChargeIdParam(param(req.params.id)),
      parseUpdateTenantChargeBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function cancelTenantChargeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantChargeService.cancelTenantCharge(
      parseTenantChargeIdParam(param(req.params.id)),
      parseCancelTenantChargeBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}

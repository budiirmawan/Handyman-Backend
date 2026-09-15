import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { serviceChargeReadinessService } from './service-charge-readiness.service';
import {
  parseCreateServiceChargeReadinessBody,
  parseServiceChargeReadinessFilters,
  parseServiceChargeReadinessIdParam,
  parseServiceChargeReadinessTenantIdParam,
  parseUpdateServiceChargeReadinessBody,
} from './service-charge-readiness.validation';
const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}
export async function createServiceChargeReadinessHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantCompanyId = parseServiceChargeReadinessTenantIdParam(param(req.params.tenantCompanyId));
    sendSuccess(res, await serviceChargeReadinessService.createServiceChargeReadiness(
      { ...parseCreateServiceChargeReadinessBody(req.body), tenantCompanyId }, actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getServiceChargeReadinessHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await serviceChargeReadinessService.getServiceChargeReadiness(
      parseServiceChargeReadinessIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listServiceChargeReadinessHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await serviceChargeReadinessService.listServiceChargeReadiness(
      parseServiceChargeReadinessFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function updateServiceChargeReadinessHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await serviceChargeReadinessService.updateServiceChargeReadiness(
      parseServiceChargeReadinessIdParam(param(req.params.id)),
      parseUpdateServiceChargeReadinessBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}

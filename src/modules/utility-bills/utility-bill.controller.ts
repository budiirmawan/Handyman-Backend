import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { utilityBillService } from './utility-bill.service';
import {
  parseGenerateUtilityBillBody,
  parseUpdateUtilityBillBody,
  parseUtilityBillFilters,
  parseUtilityBillIdParam,
  parseUtilityBillTenantIdParam,
} from './utility-bill.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}
export async function generateUtilityBillHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantCompanyId = parseUtilityBillTenantIdParam(param(req.params.tenantCompanyId));
    sendSuccess(res, await utilityBillService.generateUtilityBill(
      { ...parseGenerateUtilityBillBody(req.body), tenantCompanyId }, actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getUtilityBillHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await utilityBillService.getUtilityBill(
      parseUtilityBillIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function getUtilityBillInvoiceReadyHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await utilityBillService.getUtilityBillInvoiceReady(
      parseUtilityBillIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}

export async function listUtilityBillsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await utilityBillService.listUtilityBills(
      parseUtilityBillFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function updateUtilityBillHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await utilityBillService.updateUtilityBill(
      parseUtilityBillIdParam(param(req.params.id)),
      parseUpdateUtilityBillBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}

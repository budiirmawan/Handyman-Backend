import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantInvoiceService } from './tenant-invoice.service';
import {
  parseAddTenantInvoiceLineBody, parseCreateTenantInvoiceBody,
  parseTenantInvoiceFilters, parseTenantInvoiceIdParam,
  parseTenantInvoiceTenantIdParam, parseUpdateTenantInvoiceBody,
} from './tenant-invoice.validation';
const param = (value: string | string[] | undefined): string => Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string { if (!req.auth) throw authenticationRequiredError(); return req.auth.userId; }
export async function createTenantInvoiceHandler(req: Request,res: Response,next: NextFunction): Promise<void> {
  try { const tenantCompanyId = parseTenantInvoiceTenantIdParam(param(req.params.tenantCompanyId));
    sendSuccess(res, await tenantInvoiceService.createTenantInvoice({ ...parseCreateTenantInvoiceBody(req.body), tenantCompanyId }, actor(req)), 201);
  } catch (error) { next(error); }
}
export async function addTenantInvoiceLineHandler(req: Request,res: Response,next: NextFunction): Promise<void> {
  try { sendSuccess(res, await tenantInvoiceService.addTenantInvoiceLine(
    parseTenantInvoiceIdParam(param(req.params.id)), parseAddTenantInvoiceLineBody(req.body), actor(req)), 201);
  } catch (error) { next(error); }
}
export async function getTenantInvoiceHandler(req: Request,res: Response,next: NextFunction): Promise<void> {
  try { sendSuccess(res, await tenantInvoiceService.getTenantInvoice(parseTenantInvoiceIdParam(param(req.params.id)), actor(req))); }
  catch (error) { next(error); }
}
export async function listTenantInvoicesHandler(req: Request,res: Response,next: NextFunction): Promise<void> {
  try { sendSuccess(res, await tenantInvoiceService.listTenantInvoices(parseTenantInvoiceFilters(req.query), actor(req))); }
  catch (error) { next(error); }
}
export async function updateTenantInvoiceHandler(req: Request,res: Response,next: NextFunction): Promise<void> {
  try { sendSuccess(res, await tenantInvoiceService.updateTenantInvoice(parseTenantInvoiceIdParam(param(req.params.id)), parseUpdateTenantInvoiceBody(req.body), actor(req))); }
  catch (error) { next(error); }
}
export async function finalizeTenantInvoiceHandler(req: Request,res: Response,next: NextFunction): Promise<void> {
  try { sendSuccess(res, await tenantInvoiceService.finalizeTenantInvoice(parseTenantInvoiceIdParam(param(req.params.id)), actor(req))); }
  catch (error) { next(error); }
}
export async function cancelTenantInvoiceHandler(req: Request,res: Response,next: NextFunction): Promise<void> {
  try { sendSuccess(res, await tenantInvoiceService.cancelTenantInvoice(parseTenantInvoiceIdParam(param(req.params.id)), actor(req))); }
  catch (error) { next(error); }
}

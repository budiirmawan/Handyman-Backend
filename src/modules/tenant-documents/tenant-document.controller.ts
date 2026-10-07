import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { tenantDocumentService } from './tenant-document.service';
import {
  parseCreateTenantDocumentBody,
  parseTenantDocumentCompanyIdParam,
  parseTenantDocumentFilters,
  parseTenantDocumentIdParam,
  parseUpdateTenantDocumentBody,
} from './tenant-document.validation';

const param = (value: string | string[] | undefined): string =>
  Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function createTenantDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tenantCompanyId = parseTenantDocumentCompanyIdParam(param(req.params.tenantCompanyId));
    sendSuccess(res, await tenantDocumentService.createTenantDocument(
      { ...parseCreateTenantDocumentBody(req.body), tenantCompanyId }, actor(req),
    ), 201);
  } catch (error) { next(error); }
}
export async function getTenantDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantDocumentService.getTenantDocument(
      parseTenantDocumentIdParam(param(req.params.id)), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function listTenantDocumentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantDocumentService.listTenantDocuments(
      parseTenantDocumentCompanyIdParam(param(req.params.tenantCompanyId)),
      parseTenantDocumentFilters(req.query), actor(req),
    ));
  } catch (error) { next(error); }
}
export async function updateTenantDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, await tenantDocumentService.updateTenantDocument(
      parseTenantDocumentIdParam(param(req.params.id)),
      parseUpdateTenantDocumentBody(req.body), actor(req),
    ));
  } catch (error) { next(error); }
}

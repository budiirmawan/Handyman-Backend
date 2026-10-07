import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { supportingDocumentService } from './supporting-document.service';
import { parseCreateSupportingDocumentBody, parseSupportingDocumentFilters, parseSupportingDocumentIdParam } from './supporting-document.validation';

function paramString(v: string | string[]): string { return Array.isArray(v) ? '' : v; }

export async function createSupportingDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const body = parseCreateSupportingDocumentBody(req.body);
    const doc = await supportingDocumentService.createSupportingDocument(body, req.auth.userId);
    sendSuccess(res, doc, 201);
  } catch (error) { next(error); }
}
export async function getSupportingDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseSupportingDocumentIdParam(paramString(req.params.id));
    const doc = await supportingDocumentService.getSupportingDocument(id, req.auth.userId);
    sendSuccess(res, doc);
  } catch (error) { next(error); }
}
export async function listSupportingDocumentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseSupportingDocumentFilters(req.query as Record<string, unknown>);
    const docs = await supportingDocumentService.listSupportingDocuments(filters, req.auth.userId);
    sendSuccess(res, docs);
  } catch (error) { next(error); }
}

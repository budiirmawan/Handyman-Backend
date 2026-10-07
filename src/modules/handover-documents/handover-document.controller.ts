import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { handoverDocumentService } from './handover-document.service';
import { parseCreateHandoverDocumentBody, parseHandoverDocumentFilters, parseHandoverDocumentIdParam } from './handover-document.validation';

function paramString(v: string | string[]): string { return Array.isArray(v) ? '' : v; }

export async function createHandoverDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const body = parseCreateHandoverDocumentBody(req.body);
    const handover = await handoverDocumentService.createHandoverDocument(body, req.auth.userId);
    sendSuccess(res, handover, 201);
  } catch (error) { next(error); }
}
export async function getHandoverDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseHandoverDocumentIdParam(paramString(req.params.id));
    const handover = await handoverDocumentService.getHandoverDocument(id, req.auth.userId);
    sendSuccess(res, handover);
  } catch (error) { next(error); }
}
export async function listHandoverDocumentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseHandoverDocumentFilters(req.query as Record<string, unknown>);
    const handovers = await handoverDocumentService.listHandoverDocuments(filters, req.auth.userId);
    sendSuccess(res, handovers);
  } catch (error) { next(error); }
}

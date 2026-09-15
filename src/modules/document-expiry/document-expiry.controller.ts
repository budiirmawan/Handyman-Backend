import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { documentExpiryService } from './document-expiry.service';
import { parseDocumentIdParam, parseSetExpiryBody, parseVersionIdParam } from './document-expiry.validation';

function paramString(v: string | string[]): string { return Array.isArray(v) ? '' : v; }

export async function setDocumentExpiryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const documentId = parseDocumentIdParam(paramString(req.params.documentId));
    const { expiryDate } = parseSetExpiryBody(req.body);
    const result = await documentExpiryService.setDocumentExpiry(documentId, expiryDate, req.auth.userId);
    sendSuccess(res, result);
  } catch (error) { next(error); }
}
export async function getDocumentExpiryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const documentId = parseDocumentIdParam(paramString(req.params.documentId));
    const result = await documentExpiryService.getDocumentExpiry(documentId, req.auth.userId);
    sendSuccess(res, result);
  } catch (error) { next(error); }
}
export async function setVersionExpiryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const versionId = parseVersionIdParam(paramString(req.params.versionId));
    const { expiryDate } = parseSetExpiryBody(req.body);
    const result = await documentExpiryService.setVersionExpiry(versionId, expiryDate, req.auth.userId);
    sendSuccess(res, result);
  } catch (error) { next(error); }
}
export async function getVersionExpiryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const versionId = parseVersionIdParam(paramString(req.params.versionId));
    const result = await documentExpiryService.getVersionExpiry(versionId, req.auth.userId);
    sendSuccess(res, result);
  } catch (error) { next(error); }
}

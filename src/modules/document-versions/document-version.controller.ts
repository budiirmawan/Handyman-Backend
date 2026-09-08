import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { documentVersionService } from './document-version.service';
import { parseCreateDocumentVersionBody, parseDocumentIdParam, parseVersionIdParam } from './document-version.validation';

function paramString(v: string | string[]): string { return Array.isArray(v) ? '' : v; }

export async function createDocumentVersionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const documentId = parseDocumentIdParam(paramString(req.params.documentId));
    const body = parseCreateDocumentVersionBody(req.body);
    const version = await documentVersionService.createDocumentVersion(documentId, body, req.auth.userId);
    sendSuccess(res, version, 201);
  } catch (error) { next(error); }
}

export async function listDocumentVersionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const documentId = parseDocumentIdParam(paramString(req.params.documentId));
    const versions = await documentVersionService.listDocumentVersions(documentId, req.auth.userId);
    sendSuccess(res, versions);
  } catch (error) { next(error); }
}

export async function getDocumentVersionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const versionId = parseVersionIdParam(paramString(req.params.versionId));
    const version = await documentVersionService.getDocumentVersion(versionId, req.auth.userId);
    sendSuccess(res, version);
  } catch (error) { next(error); }
}

export async function getDocumentVersionByNumberHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const documentId = parseDocumentIdParam(paramString(req.params.documentId));
    const versionNumber = Number(paramString(req.params.versionNumber));
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      const { AppError } = await import('../../shared/errors');
      throw AppError.validation('Request validation failed.', [{ field: 'versionNumber', message: 'versionNumber must be a positive integer.' }]);
    }
    const version = await documentVersionService.getDocumentVersionByNumber(documentId, versionNumber, req.auth.userId);
    sendSuccess(res, version);
  } catch (error) { next(error); }
}

export async function resolveLatestVersionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const documentId = parseDocumentIdParam(paramString(req.params.documentId));
    const version = await documentVersionService.resolveLatestVersion(documentId, req.auth.userId);
    sendSuccess(res, version);
  } catch (error) { next(error); }
}

import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { documentService } from './document.service';
import { parseArchiveDocumentBody } from './document-archive.validation';
import {
  parseCreateDocumentBody,
  parseDocumentFilters,
  parseDocumentIdParam,
  parseUpdateDocumentBody,
} from './document.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

export async function createDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const body = parseCreateDocumentBody(req.body);
    const doc = await documentService.createDocument(body, req.auth.userId);
    sendSuccess(res, doc, 201);
  } catch (error) {
    next(error);
  }
}

export async function getDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseDocumentIdParam(paramString(req.params.id));
    const doc = await documentService.getDocument(id, req.auth.userId);
    sendSuccess(res, doc);
  } catch (error) {
    next(error);
  }
}

export async function listDocumentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseDocumentFilters(req.query as Record<string, unknown>);
    const docs = await documentService.listDocuments(filters, req.auth.userId);
    sendSuccess(res, docs);
  } catch (error) {
    next(error);
  }
}

export async function updateDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseDocumentIdParam(paramString(req.params.id));
    const body = parseUpdateDocumentBody(req.body);
    const doc = await documentService.updateDocument(id, body, req.auth.userId);
    sendSuccess(res, doc);
  } catch (error) {
    next(error);
  }
}

export async function archiveDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseDocumentIdParam(paramString(req.params.id));
    const { reason } = parseArchiveDocumentBody(req.body);
    const doc = await documentService.archiveDocument(id, reason, req.auth.userId);
    sendSuccess(res, doc);
  } catch (error) {
    next(error);
  }
}

export async function restoreDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseDocumentIdParam(paramString(req.params.id));
    const doc = await documentService.restoreDocument(id, req.auth.userId);
    sendSuccess(res, doc);
  } catch (error) {
    next(error);
  }
}

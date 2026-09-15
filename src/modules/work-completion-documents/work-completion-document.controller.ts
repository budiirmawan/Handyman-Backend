import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { workCompletionDocumentService } from './work-completion-document.service';
import {
  parseCreateWorkCompletionDocumentBody,
  parseWorkCompletionFilters,
  parseWorkCompletionIdParam,
} from './work-completion-document.validation';

function paramString(v: string | string[]): string {
  return Array.isArray(v) ? '' : v;
}

export async function createWorkCompletionDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const body = parseCreateWorkCompletionDocumentBody(req.body);
    const doc = await workCompletionDocumentService.createWorkCompletionDocument(body, req.auth.userId);
    sendSuccess(res, doc, 201);
  } catch (error) {
    next(error);
  }
}

export async function getWorkCompletionDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseWorkCompletionIdParam(paramString(req.params.id));
    const doc = await workCompletionDocumentService.getWorkCompletionDocument(id, req.auth.userId);
    sendSuccess(res, doc);
  } catch (error) {
    next(error);
  }
}

export async function listWorkCompletionDocumentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseWorkCompletionFilters(req.query as Record<string, unknown>);
    const docs = await workCompletionDocumentService.listWorkCompletionDocuments(filters, req.auth.userId);
    sendSuccess(res, docs);
  } catch (error) {
    next(error);
  }
}

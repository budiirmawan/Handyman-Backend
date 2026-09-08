import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { documentApprovalService } from './document-approval.service';
import {
  parseCreateDocumentApprovalBody,
  parseDocumentApprovalDecisionBody,
  parseDocumentApprovalIdParam,
  parseDocumentIdParam,
} from './document-approval.validation';

function paramString(v: string | string[]): string { return Array.isArray(v) ? '' : v; }

export async function submitForApprovalHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const documentId = parseDocumentIdParam(paramString(req.params.documentId));
    const body = parseCreateDocumentApprovalBody(req.body);
    const approval = await documentApprovalService.submitForApproval(
      { documentId, ...body },
      req.auth.userId,
    );
    sendSuccess(res, approval, 201);
  } catch (error) { next(error); }
}

export async function approveHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseDocumentApprovalIdParam(paramString(req.params.id));
    const body = parseDocumentApprovalDecisionBody(req.body);
    const approval = await documentApprovalService.approve(id, req.auth.userId, body.notes ?? null);
    sendSuccess(res, approval);
  } catch (error) { next(error); }
}

export async function rejectHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseDocumentApprovalIdParam(paramString(req.params.id));
    const body = parseDocumentApprovalDecisionBody(req.body);
    const approval = await documentApprovalService.reject(id, req.auth.userId, body.notes ?? null);
    sendSuccess(res, approval);
  } catch (error) { next(error); }
}

export async function getApprovalStatusHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseDocumentApprovalIdParam(paramString(req.params.id));
    const approval = await documentApprovalService.getApprovalStatus(id, req.auth.userId);
    sendSuccess(res, approval);
  } catch (error) { next(error); }
}

export async function listApprovalHistoryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const documentId = parseDocumentIdParam(paramString(req.params.documentId));
    const history = await documentApprovalService.listApprovalHistory(documentId, req.auth.userId);
    sendSuccess(res, history);
  } catch (error) { next(error); }
}

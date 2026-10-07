import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import { bastDocumentService } from './bast-document.service';
import {
  parseBastDocumentFilters,
  parseBastDocumentIdParam,
  parseBastReconciliationBuildingId,
  parseCreateBastDocumentBody,
  parseDecideBastDocumentBody,
  parseSubmitBastDocumentBody,
} from './bast-document.validation';

function paramString(v: string | string[]): string { return Array.isArray(v) ? '' : v; }

export async function createBastDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const body = parseCreateBastDocumentBody(req.body);
    const bast = await bastDocumentService.createBastDocument(body, req.auth.userId);
    sendSuccess(res, bast, 201);
  } catch (error) { next(error); }
}
export async function getBastReconciliationInventoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const buildingId = parseBastReconciliationBuildingId(
      req.query as Record<string, unknown>,
    );
    const inventory = await bastDocumentService.getBastReconciliationInventory(
      buildingId,
      req.auth.userId,
    );
    sendSuccess(res, inventory);
  } catch (error) {
    next(error);
  }
}

export async function submitBastDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseBastDocumentIdParam(paramString(req.params.id));
    const body = parseSubmitBastDocumentBody(req.body);
    const result = await bastDocumentService.submitBastDocument(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function resubmitBastDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseBastDocumentIdParam(paramString(req.params.id));
    const body = parseSubmitBastDocumentBody(req.body);
    const result = await bastDocumentService.resubmitBastDocument(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function decideBastDocumentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseBastDocumentIdParam(paramString(req.params.id));
    const body = parseDecideBastDocumentBody(req.body);
    const result = await bastDocumentService.decideBastDocument(
      id,
      body,
      req.auth.userId,
    );
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

export async function getBastDocumentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const id = parseBastDocumentIdParam(paramString(req.params.id));
    const bast = await bastDocumentService.getBastDocument(id, req.auth.userId);
    sendSuccess(res, bast);
  } catch (error) { next(error); }
}
export async function listBastDocumentsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const filters = parseBastDocumentFilters(req.query as Record<string, unknown>);
    const basts = await bastDocumentService.listBastDocuments(filters, req.auth.userId);
    sendSuccess(res, basts);
  } catch (error) { next(error); }
}

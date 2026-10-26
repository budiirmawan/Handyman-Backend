/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01A — THIN handlers for the issuer profile.
 *
 * Each handler does exactly: auth actor → whitelist parse → the existing
 * service → bounded serialization. Zero decision logic lives here: provider
 * Client existence, the accessible-Client wall, field rules, the version
 * chain, optimistic concurrency and journalling all stay in
 * `handyman-document-issuer.service`, so the HTTP path and any future internal
 * caller can never drift apart.
 */
import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  getHandymanDocumentIssuerProfile,
  listHandymanDocumentIssuerProfileHistory,
  updateHandymanDocumentIssuerProfile,
} from './handyman-document-issuer.service';
import {
  parseClientIdParam,
  parseHistoryQuery,
  parseIssuerProfileUpdate,
} from './handyman-document-issuer.validation';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function getHandymanDocumentIssuerProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientIdParam(req.params.clientId);
    const profile = await getHandymanDocumentIssuerProfile(clientId, actor(req));
    sendSuccess(res, profile);
  } catch (error) {
    next(error);
  }
}

export async function putHandymanDocumentIssuerProfileHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientIdParam(req.params.clientId);
    const input = parseIssuerProfileUpdate(req.body, clientId);
    const updated = await updateHandymanDocumentIssuerProfile(input, actor(req));
    sendSuccess(res, updated, updated.previousVersion === null ? 201 : 200);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanDocumentIssuerProfileHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientIdParam(req.params.clientId);
    const { limit } = parseHistoryQuery(req.query as Record<string, unknown>);
    const history = await listHandymanDocumentIssuerProfileHistory(
      clientId,
      actor(req),
      limit,
    );
    sendSuccess(res, history, 200, { limit });
  } catch (error) {
    next(error);
  }
}

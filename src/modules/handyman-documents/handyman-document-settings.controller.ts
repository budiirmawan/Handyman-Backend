/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01C — THIN handlers for document settings.
 *
 * Exactly: auth actor → whitelist parse (path identity + content vocabulary) →
 * the existing service → bounded serialization. Kind and language come from the
 * PATH only, so a body can never re-target another provider, another document
 * type or another language. The separate Payment Receipt action records only
 * an explicit numbering-policy approval, not a price, customer acceptance,
 * warranty activation or issued number.
 */
import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError } from '../../shared/errors';
import { activatePaymentReceiptNumbering } from './handyman-payment-receipt-numbering.service';
import { authenticationRequiredError } from '../auth';
import {
  getHandymanDocumentSettings,
  listHandymanDocumentSettings,
  listHandymanDocumentSettingsHistory,
  updateHandymanDocumentSettings,
} from './handyman-document-settings.service';
import {
  parseClientIdParam,
  parseHistoryQuery,
  parseSettingsTarget,
  parseSettingsUpdate,
} from './handyman-document-settings.validation';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function listHandymanDocumentSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientIdParam(req.params.clientId);
    const settings = await listHandymanDocumentSettings(clientId, actor(req));
    sendSuccess(res, settings, 200, { count: settings.length });
  } catch (error) {
    next(error);
  }
}

export async function getHandymanDocumentSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { clientId, documentKind, language } = parseSettingsTarget({
      clientId: req.params.clientId,
      documentKind: req.params.documentKind,
      language: req.params.language,
    });
    const settings = await getHandymanDocumentSettings(
      clientId,
      documentKind,
      language,
      actor(req),
    );
    sendSuccess(res, settings);
  } catch (error) {
    next(error);
  }
}

export async function putHandymanDocumentSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const target = parseSettingsTarget({
      clientId: req.params.clientId,
      documentKind: req.params.documentKind,
      language: req.params.language,
    });
    const input = parseSettingsUpdate(req.body, target);
    const updated = await updateHandymanDocumentSettings(input, actor(req));
    sendSuccess(res, updated, updated.previousVersion === null ? 201 : 200);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanDocumentSettingsHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { clientId, documentKind, language } = parseSettingsTarget({
      clientId: req.params.clientId,
      documentKind: req.params.documentKind,
      language: req.params.language,
    });
    const { limit } = parseHistoryQuery(req.query as Record<string, unknown>);
    const history = await listHandymanDocumentSettingsHistory(
      clientId,
      documentKind,
      language,
      actor(req),
      limit,
    );
    sendSuccess(res, history, 200, { limit });
  } catch (error) {
    next(error);
  }
}

/** This records a separate authorized policy decision; it never issues a receipt. */
export async function activatePaymentReceiptNumberingHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.auth) throw authenticationRequiredError();
    const target = parseSettingsTarget({ clientId: req.params.clientId, documentKind: req.params.documentKind, language: req.params.language });
    const body: unknown = req.body;
    if (target.documentKind !== 'PAYMENT_RECEIPT' || !body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(k => !['settingsId', 'settingsVersion', 'policyCode', 'approve'].includes(k))) {
      throw AppError.validation('Invalid Payment Receipt numbering approval.');
    }
    const value = body as Record<string, unknown>;
    const approval = await activatePaymentReceiptNumbering({ clientId: target.clientId, language: target.language,
      settingsId: value.settingsId, settingsVersion: value.settingsVersion, policyCode: value.policyCode, approve: value.approve,
      actorUserId: req.auth.userId, sessionId: req.auth.sessionId });
    sendSuccess(res, approval, approval.replayed ? 200 : 201);
  } catch (error) { next(error); }
}

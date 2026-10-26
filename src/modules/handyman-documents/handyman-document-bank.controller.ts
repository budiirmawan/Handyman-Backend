/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01B — THIN handlers for the issuer bank
 * account surface.
 *
 * Each handler does exactly: auth actor → whitelist parse → the existing
 * service → masked serialization. Zero decision logic lives here: provider
 * Client existence, the accessible-Client wall, the currency policy, the
 * version chain, the verification act, the default-replacement authorization and
 * the journalling all stay in `handyman-document-bank.service`, so the HTTP path
 * and the internal resolver can never disagree. Note what is NOT here: no route
 * accepts a status, a default flag or a verification timestamp, and no route
 * deletes anything.
 */
import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  activateHandymanDocumentBankAccount,
  createHandymanDocumentBankAccount,
  deactivateHandymanDocumentBankAccount,
  getHandymanDocumentBankAccount,
  listHandymanDocumentBankAccountHistory,
  listHandymanDocumentBankAccounts,
  updateHandymanDocumentBankAccount,
} from './handyman-document-bank.service';
import {
  parseBankAccountActivation,
  parseBankAccountCreate,
  parseBankAccountDeactivation,
  parseBankAccountHistoryQuery,
  parseBankAccountIdParam,
  parseBankAccountListQuery,
  parseBankAccountUpdate,
  parseClientIdParam,
} from './handyman-document-bank.validation';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

function params(req: Request): { clientId: string; bankAccountId: string } {
  return {
    clientId: parseClientIdParam(req.params.clientId),
    bankAccountId: parseBankAccountIdParam(req.params.bankAccountId),
  };
}

export async function listHandymanDocumentBankAccountsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientIdParam(req.params.clientId);
    const filter = parseBankAccountListQuery(req.query as Record<string, unknown>);
    const accounts = await listHandymanDocumentBankAccounts(clientId, actor(req), filter);
    sendSuccess(res, accounts, 200, { limit: filter.limit });
  } catch (error) {
    next(error);
  }
}

export async function createHandymanDocumentBankAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const clientId = parseClientIdParam(req.params.clientId);
    const input = parseBankAccountCreate(req.body, clientId);
    const created = await createHandymanDocumentBankAccount(input, actor(req));
    sendSuccess(res, created, 201);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanDocumentBankAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { clientId, bankAccountId } = params(req);
    const account = await getHandymanDocumentBankAccount(clientId, bankAccountId, actor(req));
    sendSuccess(res, account);
  } catch (error) {
    next(error);
  }
}

export async function updateHandymanDocumentBankAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { clientId, bankAccountId } = params(req);
    const input = parseBankAccountUpdate(req.body, clientId, bankAccountId);
    const updated = await updateHandymanDocumentBankAccount(input, actor(req));
    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanDocumentBankAccountHistoryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { clientId, bankAccountId } = params(req);
    const { limit } = parseBankAccountHistoryQuery(req.query as Record<string, unknown>);
    const history = await listHandymanDocumentBankAccountHistory(
      clientId,
      bankAccountId,
      actor(req),
      limit,
    );
    sendSuccess(res, history, 200, { limit });
  } catch (error) {
    next(error);
  }
}

export async function activateHandymanDocumentBankAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { clientId, bankAccountId } = params(req);
    const input = parseBankAccountActivation(req.body, clientId, bankAccountId);
    const activated = await activateHandymanDocumentBankAccount(input, actor(req));
    sendSuccess(res, activated);
  } catch (error) {
    next(error);
  }
}

export async function deactivateHandymanDocumentBankAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { clientId, bankAccountId } = params(req);
    const input = parseBankAccountDeactivation(req.body, clientId, bankAccountId);
    const deactivated = await deactivateHandymanDocumentBankAccount(input, actor(req));
    sendSuccess(res, deactivated);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-BE-SAAS-01 PART 06 — platform-billing HTTP handlers (SaaS Control
 * Plane). Express 5 types path params as `string | string[]`; normalize.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import {
  hasPaginationParams,
  parsePagination,
  buildPaginationMeta,
} from '../../shared/pagination';
import { sendSuccess } from '../../shared/api-response';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import {
  createSaasBillingAccount,
  getSaasBillingAccount,
  listSaasBillingAccounts,
  updateSaasBillingAccount,
} from './platform-billing-account.service';
import {
  createSaasInvoice,
  getSaasInvoiceDetail,
  issueSaasInvoice,
  listSaasInvoices,
  voidSaasInvoice,
} from './platform-invoice.service';
import {
  parseCreateSaasBillingAccountBody,
  parseCreateSaasInvoiceBody,
  parseIssueSaasInvoiceBody,
  parseListSaasInvoiceFilters,
  parseUpdateSaasBillingAccountBody,
  parseVoidSaasInvoiceBody,
} from './platform-billing.validation';

function paramString(value: string | string[]): string {
  return Array.isArray(value) ? '' : value;
}

function parseIdParam(param: string, field: string): string {
  const value = param?.trim();
  if (
    !value ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a UUID.` },
    ]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Billing accounts — /platform/billing-accounts
// ---------------------------------------------------------------------------

/** GET /platform/billing-accounts (platform.billing.read). */
export async function listSaasBillingAccountsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const pagination = parsePagination(query);
    const usePagination = hasPaginationParams(query);

    const result = await listSaasBillingAccounts({
      withTotal: usePagination,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    sendSuccess(
      res,
      result.records,
      200,
      usePagination
        ? buildPaginationMeta(pagination.page, pagination.pageSize, result.total ?? 0)
        : {},
    );
  } catch (error) {
    next(error);
  }
}

/** POST /platform/billing-accounts (platform.billing.manage, Idem.). */
export async function createSaasBillingAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const input = parseCreateSaasBillingAccountBody(req.body);

    const result = await createSaasBillingAccount(
      req.auth.userId,
      'platform.billing.manage',
      input,
      idempotencyKey,
    );

    sendSuccess(res, result.data, result.replayed ? 200 : 201, {
      replayed: result.replayed,
    });
  } catch (error) {
    next(error);
  }
}

/** GET /platform/billing-accounts/:id (platform.billing.read). */
export async function getSaasBillingAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseIdParam(paramString(req.params.id), 'id');
    const record = await getSaasBillingAccount(id);
    sendSuccess(res, record);
  } catch (error) {
    next(error);
  }
}

/** PATCH /platform/billing-accounts/:id (platform.billing.manage, ver). */
export async function updateSaasBillingAccountHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseIdParam(paramString(req.params.id), 'id');
    const input = parseUpdateSaasBillingAccountBody(req.body);

    const record = await updateSaasBillingAccount(
      req.auth.userId,
      'platform.billing.manage',
      id,
      input,
    );

    sendSuccess(res, record);
  } catch (error) {
    next(error);
  }
}

// ---------------------------------------------------------------------------
// Invoices — /platform/invoices
// ---------------------------------------------------------------------------

/** GET /platform/invoices (platform.billing.read; frozen filters). */
export async function listSaasInvoicesHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = parseListSaasInvoiceFilters(query);
    const pagination = parsePagination(query);
    const usePagination = hasPaginationParams(query);

    const result = await listSaasInvoices({
      filters,
      withTotal: usePagination,
      page: pagination.page,
      pageSize: pagination.pageSize,
    });

    sendSuccess(
      res,
      result.records,
      200,
      usePagination
        ? buildPaginationMeta(pagination.page, pagination.pageSize, result.total ?? 0)
        : {},
    );
  } catch (error) {
    next(error);
  }
}

/**
 * POST /platform/invoices (platform.billing.manage, Idem.): DRAFT, or
 * draft+issue when `issue: true`.
 */
export async function createSaasInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const input = parseCreateSaasInvoiceBody(req.body);

    const result = await createSaasInvoice(
      req.auth.userId,
      'platform.billing.manage',
      input,
      idempotencyKey,
    );

    sendSuccess(res, result.data, result.replayed ? 200 : 201, {
      replayed: result.replayed,
    });
  } catch (error) {
    next(error);
  }
}

/** GET /platform/invoices/:id (platform.billing.read) — with lines. */
export async function getSaasInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseIdParam(paramString(req.params.id), 'id');
    const detail = await getSaasInvoiceDetail(id);
    sendSuccess(res, detail);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /platform/invoices/:id/issue (platform.billing.manage, Idem. +
 * ver) — DRAFT → ISSUED.
 */
export async function issueSaasInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseIdParam(paramString(req.params.id), 'id');
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const input = parseIssueSaasInvoiceBody(req.body);

    const result = await issueSaasInvoice(
      req.auth.userId,
      'platform.billing.manage',
      id,
      input,
      idempotencyKey,
    );

    sendSuccess(res, result.data, 200, { replayed: result.replayed });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /platform/invoices/:id/void (platform.billing.manage, ver;
 * reason mandatory) — DRAFT/ISSUED → VOID (terminal).
 */
export async function voidSaasInvoiceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const id = parseIdParam(paramString(req.params.id), 'id');
    const input = parseVoidSaasInvoiceBody(req.body);

    const record = await voidSaasInvoice(
      req.auth.userId,
      'platform.billing.manage',
      id,
      input,
    );

    sendSuccess(res, record);
  } catch (error) {
    next(error);
  }
}

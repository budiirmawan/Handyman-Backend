/**
 * CR-BE-SAAS-01 PART 07 — HTTP controller (frozen §22).
 *
 * Routes implemented exactly as the frozen §22 surface:
 *   GET  /api/v1/platform/payments                (frozen §22 row)
 *   POST /api/v1/platform/payments                (frozen §22 row, Idem.)
 *   GET  /api/v1/platform/payments/:id            (with allocations)
 *   POST /api/v1/platform/payments/:id/reconcile  (Idem. + expectedVersion)
 *   POST /api/v1/platform/payments/:id/reject     (reason + expectedVersion)
 */
import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import {
  getSaasPaymentDetail,
  ingestSaasPayment,
  listSaasPayments,
  reconcileSaasPayment,
  rejectSaasPayment,
} from './platform-payments.service';
import {
  isValidPaymentId,
  parseIngestSaasPaymentInput,
  parseReconcileSaasPaymentInput,
  parseRejectSaasPaymentInput,
  rejectForbiddenIngestKeys,
  rejectForbiddenReconcileKeys,
} from './platform-payments.validation';

function ensureId(req: Request, key: string): string {
  const raw = (req.params as Record<string, string | string[] | undefined>)[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw AppError.validation('Request validation failed.', [
      { field: key, message: `${key} path parameter is invalid.` },
    ]);
  }
  return value;
}

function ensurePaymentId(req: Request): string {
  const id = ensureId(req, 'paymentId');
  if (!isValidPaymentId(id)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'paymentId', message: 'paymentId path parameter is invalid.' },
    ]);
  }
  return id;
}

function ensureActor(req: Request): string {
  const actorUserId = req.auth?.userId;
  if (!actorUserId) {
    throw new AppError({
      code: ERROR_CODES.AUTHENTICATION_REQUIRED,
      message: 'Authenticated actor is required.',
      statusCode: 401,
    });
  }
  return actorUserId;
}

function assertNoFailures(
  failures: { field: string; message: string }[],
): void {
  if (failures.length > 0) {
    throw AppError.validation('Request validation failed.', failures);
  }
}

export async function listSaasPaymentsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.query as Record<string, unknown>;
    const filters = {
      customerId: typeof query.customerId === 'string' ? query.customerId : undefined,
      status:
        typeof query.status === 'string'
          ? (query.status as 'PENDING' | 'RECONCILED' | 'REJECTED')
          : undefined,
      billingAccountId:
        typeof query.billingAccountId === 'string'
          ? query.billingAccountId
          : undefined,
    };
    const page = Number(query.page ?? 0);
    const pageSize = Number(query.pageSize ?? 50);
    const limit = Math.min(Math.max(pageSize, 1), 200);
    const offset = page > 0 ? (page - 1) * limit : 0;
    const result = await listSaasPayments(filters, {
      limit,
      offset,
      withTotal: Boolean(query.includeTotal),
    });
    sendSuccess(res, {
      payments: result.records,
      total: result.total,
      page: page || 1,
      pageSize: limit,
    });
  } catch (error) {
    next(error);
  }
}

export async function ingestSaasPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = req.body ?? {};
    const forbidden = rejectForbiddenIngestKeys(body);
    if (forbidden.length > 0) {
      throw AppError.validation('Request validation failed.', forbidden);
    }
    const parsed = parseIngestSaasPaymentInput(body);
    assertNoFailures(parsed.failures);
    if (!parsed.value) {
      throw AppError.validation('Request validation failed.', [
        { field: 'body', message: 'Body is required.' },
      ]);
    }
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const actorUserId = ensureActor(req);
    const authority = `platform.user:${actorUserId}`;
    const out = await ingestSaasPayment(
      actorUserId,
      authority,
      parsed.value,
      idempotencyKey,
    );
    sendSuccess(res, { ...out.data, replayed: out.replayed }, 201);
  } catch (error) {
    next(error);
  }
}

export async function getSaasPaymentDetailHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const paymentId = ensurePaymentId(req);
    const payment = await getSaasPaymentDetail(paymentId);
    sendSuccess(res, { payment });
  } catch (error) {
    next(error);
  }
}

export async function reconcileSaasPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const paymentId = ensurePaymentId(req);
    const body = req.body ?? {};
    const forbidden = rejectForbiddenReconcileKeys(body);
    if (forbidden.length > 0) {
      throw AppError.validation('Request validation failed.', forbidden);
    }
    const parsed = parseReconcileSaasPaymentInput(body);
    assertNoFailures(parsed.failures);
    if (!parsed.value) {
      throw AppError.validation('Request validation failed.', [
        { field: 'body', message: 'Body is required.' },
      ]);
    }
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const actorUserId = ensureActor(req);
    const authority = `platform.user:${actorUserId}`;
    const out = await reconcileSaasPayment(
      actorUserId,
      authority,
      paymentId,
      parsed.value,
      idempotencyKey,
    );
    sendSuccess(res, { ...out.data, replayed: out.replayed });
  } catch (error) {
    next(error);
  }
}

export async function rejectSaasPaymentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const paymentId = ensurePaymentId(req);
    const body = req.body ?? {};
    const parsed = parseRejectSaasPaymentInput(body);
    assertNoFailures(parsed.failures);
    if (!parsed.value) {
      throw AppError.validation('Request validation failed.', [
        { field: 'body', message: 'Body is required.' },
      ]);
    }
    const actorUserId = ensureActor(req);
    const authority = `platform.user:${actorUserId}`;
    const out = await rejectSaasPayment(
      actorUserId,
      authority,
      paymentId,
      parsed.value,
    );
    sendSuccess(res, { payment: out.data });
  } catch (error) {
    next(error);
  }
}

/**
 * CR-BE-SAAS-01 PART 05 — Provisioning HTTP controller (frozen §22).
 *
 * Routes exposed (control-plane only):
 *   POST /api/v1/platform/customers/:customerId/provision
 *   GET  /api/v1/platform/customers/:customerId/provisioning
 *   GET  /api/v1/platform/customers/:customerId/provisioning/runs
 *
 * The body parser on these routes is the ONLY place where commercial /
 * lifecycle fields are rejected (see `platform-provisioning.validation.ts`).
 */
import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { parseIdempotencyKeyRequired } from '../request-idempotency';
import {
  getProvisioningRun,
  getProvisioningSummary,
  listProvisioningRuns,
  provisionCustomer,
} from './platform-provisioning.service';
import {
  isValidCustomerId,
  isValidRunId,
  parseProvisionCustomerInput,
  rejectForbiddenKeys,
} from './platform-provisioning.validation';

function paramString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? '') as string;
  return (value ?? '') as string;
}

function ensureCustomerId(req: Request): string {
  const raw = (req.params as { customerId?: string | string[] }).customerId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!isValidCustomerId(id)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'customerId',
        message: 'customerId path parameter is invalid.',
      },
    ]);
  }
  return id;
}

function ensureRunId(req: Request): string {
  const raw = (req.params as { runId?: string | string[] }).runId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  if (!isValidRunId(id)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'runId', message: 'runId path parameter is invalid.' },
    ]);
  }
  return id;
}

export async function provisionCustomerHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const customerId = ensureCustomerId(req);
    const body = (req.body ?? {}) as unknown;
    const forbidden = rejectForbiddenKeys(body);
    if (forbidden.length > 0) {
      throw AppError.validation('Request validation failed.', forbidden);
    }
    const parsed = parseProvisionCustomerInput(body);
    if (parsed.failures.length > 0 || !parsed.value) {
      throw AppError.validation(
        'Request validation failed.',
        parsed.failures.length > 0 ? parsed.failures : [{ field: 'body', message: 'Body is required.' }],
      );
    }

    // Idempotency-Key is REQUIRED for write commands (frozen §11.2).
    const idempotencyHeader = req.header('idempotency-key');
    const idempotencyKey = parseIdempotencyKeyRequired(idempotencyHeader);

    const actorUserId = req.auth?.userId;
    if (!actorUserId) {
      throw new AppError({
        code: ERROR_CODES.AUTHENTICATION_REQUIRED,
        message: 'Authenticated actor is required.',
        statusCode: 401,
      });
    }
    const authority = `platform.user:${actorUserId}`;

    const out = await provisionCustomer(
      actorUserId,
      authority,
      customerId,
      parsed.value,
      idempotencyKey,
    );
    sendSuccess(
      res,
      { ...out.data, replayed: out.replayed },
      201,
    );
  } catch (error) {
    next(error);
  }
}

export async function getProvisioningSummaryHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const customerId = ensureCustomerId(req);
    const summary = await getProvisioningSummary(customerId);
    sendSuccess(res, summary);
  } catch (error) {
    next(error);
  }
}

export async function listProvisioningRunsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const customerId = ensureCustomerId(req);
    const runs = await listProvisioningRuns(customerId);
    sendSuccess(res, { runs });
  } catch (error) {
    next(error);
  }
}

export async function getProvisioningRunHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const runId = ensureRunId(req);
    const run = await getProvisioningRun(runId);
    sendSuccess(res, { run });
  } catch (error) {
    next(error);
  }
}

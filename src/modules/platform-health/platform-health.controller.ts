/**
 * CR-BE-SAAS-01 PART 10B — Tenant health + commercial dashboard
 * controllers (frozen §22).
 *
 * Controllers perform input validation + permission enforcement only.
 * All business logic and frozen-projection derivation live in the
 * read-model services (PART 10A `tenant-health.service`,
 * `dashboard.service`). This module does NOT recompute any health or
 * commercial rule — it only validates the inbound request and returns
 * the projection.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { getTenantHealth } from './tenant-health.service';
import { getCommercialSummary } from './dashboard.service';

function ensureUuid(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a UUID.` },
    ]);
  }
  return value;
}

export async function getTenantHealthHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    if (typeof q['customerId'] !== 'string' || q['customerId'].length === 0) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'customerId',
          message: 'customerId query param required.',
        },
      ]);
    }
    const customerId = ensureUuid(q['customerId'], 'customerId');
    const projection = await getTenantHealth(customerId);
    sendSuccess(res, projection);
  } catch (error) {
    next(error);
  }
}

export async function getCommercialSummaryHandler(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const summary = await getCommercialSummary();
    sendSuccess(res, summary);
  } catch (error) {
    next(error);
  }
}

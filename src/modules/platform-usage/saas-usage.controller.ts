/**
 * CR-BE-SAAS-01 PART 09 — Usage HTTP controller (frozen §22).
 *
 * Routes:
 *   GET  /api/v1/platform/usage/meters        (platform.usage.read)
 *   POST /api/v1/platform/usage/meters        (platform.billing.manage)
 *   GET  /api/v1/platform/usage                (platform.usage.read)
 *   POST /api/v1/platform/usage/records        (platform.billing.manage, Idem.)
 *   GET  /api/v1/platform/customers/:id/usage  (platform.usage.read) — §22
 *   GET  /api/v1/me/usage                      (platform.usage.read) — §22
 */
import type { NextFunction, Request, Response } from 'express';
import { parseIdempotencyKeyRequired } from '../../modules/request-idempotency';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import {
  createSaasUsageMeter,
  getCustomerUsageProjection,
  listSaasUsageMeters,
  listSaasUsageRecords,
  recordSaasUsage,
} from './saas-usage.service';
import type {
  CreateSaasMeterInput,
  ListUsageRecordsParams,
  RecordUsageInput,
  SaasUsageScope,
} from './saas-usage.types';

const PERIOD_TYPES = ['DAILY', 'MONTHLY', 'BILLING_PERIOD'] as const;
const SCOPES = ['CURRENT', 'DAILY', 'MONTHLY', 'BILLING_PERIOD'] as const;
const SOURCES = ['BACKEND', 'TRUSTED_INTEGRATION'] as const;

export function ensureActor(req: Request): string {
  const auth = (req as unknown as { auth?: { userId?: string } }).auth;
  const actor = auth?.userId;
  if (typeof actor !== 'string' || actor.length === 0) {
    throw new AppError({
      code: 'UNAUTHENTICATED' as never,
      message: 'Authentication required.',
      statusCode: 401,
    });
  }
  return actor;
}

export function ensureUuid(value: unknown, field: string): string {
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

export async function listSaasUsageMetersHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const meters = await listSaasUsageMeters();
    sendSuccess(res, { meters });
  } catch (error) {
    next(error);
  }
}

export async function createSaasUsageMeterHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: CreateSaasMeterInput = {
      meterKey: typeof body['meterKey'] === 'string' ? body['meterKey'] : '',
      name: typeof body['name'] === 'string' ? body['name'] : '',
      unit: typeof body['unit'] === 'string' ? body['unit'] : '',
      periodTypes: Array.isArray(body['periodTypes'])
        ? (body['periodTypes'] as readonly string[]).filter(
            (v): v is 'DAILY' | 'MONTHLY' | 'BILLING_PERIOD' =>
              (PERIOD_TYPES as readonly string[]).includes(v),
          )
        : [],
    };
    if (
      !input.meterKey ||
      !input.name ||
      !input.unit ||
      input.periodTypes.length === 0
    ) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'meterKey',
          message:
            'meterKey, name, unit, and a non-empty periodTypes array are required.',
        },
      ]);
    }
    const created = await createSaasUsageMeter(input);
    sendSuccess(res, { meter: created }, 201);
  } catch (error) {
    next(error);
  }
}

export async function recordSaasUsageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idempotencyKey = parseIdempotencyKeyRequired(
      req.header('idempotency-key'),
    );
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: RecordUsageInput = {
      customerId: ensureUuid(body['customerId'], 'customerId'),
      meterKey: typeof body['meterKey'] === 'string' ? body['meterKey'] : '',
      quantity: typeof body['quantity'] === 'string' ? body['quantity'] : '0',
      scope:
        typeof body['scope'] === 'string' &&
        (SCOPES as readonly string[]).includes(body['scope'])
          ? (body['scope'] as SaasUsageScope)
          : 'CURRENT',
      periodStart:
        typeof body['periodStart'] === 'string' ? body['periodStart'] : '',
      periodEnd:
        typeof body['periodEnd'] === 'string' ? body['periodEnd'] : '',
      source:
        typeof body['source'] === 'string' &&
        (SOURCES as readonly string[]).includes(body['source'])
          ? (body['source'] as 'BACKEND' | 'TRUSTED_INTEGRATION')
          : 'BACKEND',
      sourceReference:
        typeof body['sourceReference'] === 'string'
          ? body['sourceReference']
          : '',
    };
    if (
      typeof body['buildingId'] === 'string' &&
      body['buildingId'].length > 0
    ) {
      input.buildingId = ensureUuid(body['buildingId'], 'buildingId');
    } else {
      input.buildingId = null;
    }
    const actorUserId = ensureActor(req);
    const authority = `platform.user:${actorUserId}`;
    const out = await recordSaasUsage(
      actorUserId,
      authority,
      input,
      idempotencyKey,
    );
    sendSuccess(res, { record: out.record, replayed: out.replayed }, 201);
  } catch (error) {
    next(error);
  }
}

export async function listSaasUsageHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const filters: ListUsageRecordsParams = {};
    if (typeof q['customerId'] === 'string') filters.customerId = q['customerId'];
    if (typeof q['meterKey'] === 'string') filters.meterKey = q['meterKey'];
    if (
      typeof q['scope'] === 'string' &&
      (SCOPES as readonly string[]).includes(q['scope'])
    ) {
      filters.scope = q['scope'] as SaasUsageScope;
    }
    if (typeof q['periodStart'] === 'string') {
      filters.periodStart = q['periodStart'];
    }
    if (typeof q['periodEnd'] === 'string') {
      filters.periodEnd = q['periodEnd'];
    }
    const records = await listSaasUsageRecords(filters);
    sendSuccess(res, { records });
  } catch (error) {
    next(error);
  }
}

export async function getCustomerUsageProjectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const customerId = ensureUuid(req.params['id'], 'id');
    const projection = await getCustomerUsageProjection(customerId);
    sendSuccess(res, projection);
  } catch (error) {
    next(error);
  }
}

export async function getMeUsageHandler(
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
    const projection = await getCustomerUsageProjection(customerId);
    sendSuccess(res, projection);
  } catch (error) {
    next(error);
  }
}

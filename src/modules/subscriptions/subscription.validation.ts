import { AppError } from '../../shared/errors';
import {
  parseClientIdParam,
  isValidUuid,
} from '../clients';
import {
  SUBSCRIPTION_STATUSES,
  isSubscriptionStatus,
  type CreateSubscriptionInput,
  type SubscriptionStatus,
  type UpdateSubscriptionStatusInput,
} from './subscription.types';

/**
 * Subscription codes are the stable business-facing identifier
 * (e.g. `ASENTRA-2026-001`). They are normalized to uppercase and allow
 * letters, digits, hyphens, and underscores.
 */
const SUBSCRIPTION_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_SUBSCRIPTION_CODE_LENGTH = 128;

const PLAN_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_PLAN_CODE_LENGTH = 64;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeSubscriptionCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidSubscriptionCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_SUBSCRIPTION_CODE_LENGTH &&
    SUBSCRIPTION_CODE_PATTERN.test(code)
  );
}

export function normalizePlanCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidPlanCode(code: string): boolean {
  return (
    code.length >= 1 &&
    code.length <= MAX_PLAN_CODE_LENGTH &&
    PLAN_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSubscriptionIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'subscriptionId', message: 'Subscription id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseSubscriptionClientIdParam(raw: string): string {
  return parseClientIdParam(raw);
}

export function parseCreateSubscriptionBody(body: unknown): CreateSubscriptionInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const clientId = readClientId(body.clientId, details);
  const code = readCode(body.code, details);
  const planCode = readPlanCode(body.planCode, details);
  const startsAt = readDate(body.startsAt, 'startsAt', details, true);
  const endsAt = readDate(body.endsAt, 'endsAt', details, false);
  const status = readStatus(body.status, details);

  if (
    !clientId ||
    !code ||
    !planCode ||
    !startsAt ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    clientId,
    code,
    planCode,
    startsAt,
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateSubscriptionStatusBody(
  body: unknown,
): UpdateSubscriptionStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      { field: 'status', message: `Status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}.` },
    ]);
  }

  return { status };
}

function readClientId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field: 'clientId', message: 'clientId is required and must be a valid UUID.' });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Subscription code is required.' });
    return undefined;
  }

  const normalized = normalizeSubscriptionCode(value);
  if (!isValidSubscriptionCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Subscription code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-128 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readPlanCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'planCode', message: 'Plan code is required.' });
    return undefined;
  }

  const normalized = normalizePlanCode(value);
  if (!isValidPlanCode(normalized)) {
    details.push({
      field: 'planCode',
      message:
        'Plan code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (1-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
  required: boolean,
): Date | undefined {
  if (value === undefined || value === null) {
    if (required) {
      details.push({ field, message: `${field} is required.` });
    }
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a valid ISO-8601 date string.` });
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    details.push({ field, message: `${field} must be a valid ISO-8601 date string.` });
    return undefined;
  }

  return date;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): SubscriptionStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSubscriptionStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

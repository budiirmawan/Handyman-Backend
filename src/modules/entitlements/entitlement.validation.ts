import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { parseSubscriptionIdParam } from '../subscriptions';
import {
  ENTITLEMENT_STATUSES,
  isEntitlementStatus,
  type CreateEntitlementInput,
  type EntitlementStatus,
  type UpdateEntitlementStatusInput,
} from './entitlement.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEntitlementIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'entitlementId', message: 'Entitlement id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseEntitlementSubscriptionIdParam(raw: string): string {
  return parseSubscriptionIdParam(raw);
}

export function parseCreateEntitlementBody(body: unknown): CreateEntitlementInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const moduleId = readModuleId(body.moduleId, details);
  const startsAt = readDate(body.startsAt, 'startsAt', details, true);
  const endsAt = readDate(body.endsAt, 'endsAt', details, false);
  const status = readStatus(body.status, details);

  if (!moduleId || !startsAt || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    moduleId,
    startsAt,
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateEntitlementStatusBody(
  body: unknown,
): UpdateEntitlementStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      { field: 'status', message: `Status must be one of: ${ENTITLEMENT_STATUSES.join(', ')}.` },
    ]);
  }

  return { status };
}

function readModuleId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field: 'moduleId', message: 'moduleId is required and must be a valid UUID.' });
    return undefined;
  }
  return value.trim().toLowerCase();
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
): EntitlementStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isEntitlementStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${ENTITLEMENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

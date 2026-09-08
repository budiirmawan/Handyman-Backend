import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { parseSubscriptionIdParam } from '../subscriptions';
import {
  LICENSE_STATUSES,
  isLicenseStatus,
  type CreateLicenseInput,
  type LicenseStatus,
  type UpdateLicenseStatusInput,
} from './license.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseLicenseIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'licenseId', message: 'License id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseLicenseSubscriptionIdParam(raw: string): string {
  return parseSubscriptionIdParam(raw);
}

export function parseCreateLicenseBody(body: unknown): CreateLicenseInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const validFrom = readDate(body.validFrom, 'validFrom', details, true);
  const validUntil = readDate(body.validUntil, 'validUntil', details, false);
  const status = readStatus(body.status, details);

  if (!validFrom || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    validFrom,
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateLicenseStatusBody(
  body: unknown,
): UpdateLicenseStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      { field: 'status', message: `Status must be one of: ${LICENSE_STATUSES.join(', ')}.` },
    ]);
  }

  return { status };
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
): LicenseStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isLicenseStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${LICENSE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

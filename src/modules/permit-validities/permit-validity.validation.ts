import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PERMIT_VALIDITY_STATUSES,
  isPermitValidityStatus,
  type PermitValidityFilters,
  type PermitValidityStatus,
  type RevokePermitValidityInput,
  type SetPermitValidityInput,
} from './permit-validity.types';

type ValidationDetail = { field: string; message: string };
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export const parsePermitValidityIdParam = (raw: string): string =>
  parseId(raw, 'permitValidityId');
export const parsePermitValidityPermitIdParam = (raw: string): string =>
  parseId(raw, 'permitId');

export function parseSetPermitValidityBody(
  body: unknown,
): SetPermitValidityInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const controlled = [
    'status',
    'activatedAt',
    'expiredAt',
    'revokedAt',
    'revokedByUserId',
    'createdByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (controlled) {
    fail([{ field: controlled, message: 'This validity field is backend-controlled.' }]);
  }
  const details: ValidationDetail[] = [];
  const permitApplicationId = readId(
    body.permitApplicationId,
    'permitApplicationId',
    true,
    details,
  );
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const validFrom = readTimestamp(body.validFrom, 'validFrom', true, details);
  const validUntil = readTimestamp(body.validUntil, 'validUntil', true, details);
  const notes = readNullableText(body.notes, 'notes', 2000, details);
  if (
    validFrom &&
    validUntil &&
    validUntil.getTime() <= validFrom.getTime()
  ) {
    details.push({
      field: 'validUntil',
      message: 'validUntil must be after validFrom.',
    });
  }
  if (
    !permitApplicationId ||
    !buildingId ||
    !validFrom ||
    !validUntil ||
    details.length > 0
  ) {
    fail(details);
  }
  return {
    permitApplicationId,
    buildingId,
    validFrom,
    validUntil,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseRevokePermitValidityBody(
  body: unknown,
): RevokePermitValidityInput {
  if (body === undefined || body === null) return {};
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const revocationNotes = readNullableText(
    body.revocationNotes ?? body.notes,
    'revocationNotes',
    2000,
    details,
  );
  if (details.length > 0) fail(details);
  return revocationNotes === undefined ? {} : { revocationNotes };
}

export function parsePermitValidityFilters(
  query: unknown,
): PermitValidityFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const permitId = readId(query.permitId, 'permitId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const status = readStatus(query.status ?? query.validityStatus, details);
  const validFrom = readTimestamp(query.validFrom, 'validFrom', false, details);
  const validUntil = readTimestamp(query.validUntil, 'validUntil', false, details);
  const validAt = readTimestamp(query.validAt, 'validAt', false, details);
  if (validFrom && validUntil && validUntil.getTime() < validFrom.getTime()) {
    details.push({ field: 'validUntil', message: 'validUntil must not precede validFrom.' });
  }
  if (details.length > 0) fail(details);
  return {
    ...(permitId ? { permitId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(status ? { status } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(validAt ? { validAt } : {}),
  };
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field}${required ? ' is required and' : ''} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readTimestamp(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): Date | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_WITH_ZONE.test(value.trim())) {
    details.push({
      field,
      message: `${field} must be an ISO-8601 date-time with a timezone.`,
    });
    return undefined;
  }
  const normalized = value.trim();
  if (!isCalendarDate(normalized.slice(0, 10))) {
    details.push({ field, message: `${field} contains an invalid calendar date.` });
    return undefined;
  }
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be a valid date and time.` });
    return undefined;
  }
  return parsed;
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): PermitValidityStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitValidityStatus(normalized)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${PERMIT_VALIDITY_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length === 0) return null;
  if (result.length > maxLength) {
    details.push({ field, message: `${field} is too long.` });
    return undefined;
  }
  return result;
}

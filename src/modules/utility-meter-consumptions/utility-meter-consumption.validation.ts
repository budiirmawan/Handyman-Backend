import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

/** BE-18G — Consumption request validation. */

const MAX_NOTES_LENGTH = 1024;
const MAX_LIMIT = 500;

export type ValidationDetail = {
  field: string;
  message: string;
};

export type CalculateUtilityMeterConsumptionBody = {
  currentReadingId: string;
  previousReadingId?: string;
  notes?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(raw: string, field: string, label: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseUtilityMeterConsumptionIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Consumption id');
}

export function parseConsumptionMeterIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter id');
}

export function parseConsumptionBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseConsumptionTenantIdParam(raw: string): string {
  return parseUuidParam(raw, 'tenantCompanyId', 'Tenant company id');
}

/**
 * Parses the calculation request.
 *
 * Only reading *references* are accepted — never a consumption value. The
 * delta is always derived from BE-18E, so there is no way to post a figure
 * that contradicts the readings behind it.
 */
export function parseCalculateUtilityMeterConsumptionBody(
  body: unknown,
): CalculateUtilityMeterConsumptionBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const currentReadingId = readRequiredUuid(
    body.currentReadingId,
    'currentReadingId',
    'Current reading id',
    details,
  );
  const previousReadingId = readOptionalUuid(
    body.previousReadingId,
    'previousReadingId',
    'Previous reading id',
    details,
  );
  const notes = readNullableNotes(body.notes, details);

  // A caller-supplied consumption value would be a second source of truth.
  if (body.consumptionValue !== undefined) {
    details.push({
      field: 'consumptionValue',
      message:
        'Consumption value is derived from the readings and must not be supplied.',
    });
  }

  if (!currentReadingId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    currentReadingId,
    ...(previousReadingId === undefined ? {} : { previousReadingId }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseConsumptionDateQuery(
  raw: string | undefined,
  field: string,
): Date | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const date = new Date(raw.trim());
  if (Number.isNaN(date.getTime())) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid ISO-8601 date string.` },
    ]);
  }
  return date;
}

export function parseConsumptionUuidQuery(
  raw: string | undefined,
  field: string,
  label: string,
): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseConsumptionLimitQuery(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'limit',
        message: `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      },
    ]);
  }
  return value;
}

function readRequiredUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${label} is required and must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readNullableNotes(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'notes', message: 'Notes must be a string or null.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > MAX_NOTES_LENGTH) {
    details.push({
      field: 'notes',
      message: `Notes must be at most ${MAX_NOTES_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  UTILITY_METER_READING_SOURCES,
  UTILITY_METER_READING_TYPES,
  isUtilityMeterReadingSource,
  isUtilityMeterReadingType,
  type UtilityMeterReadingSource,
  type UtilityMeterReadingType,
} from './utility-meter-reading.types';

/** BE-18E — Meter Reading request validation. */

const MAX_NOTES_LENGTH = 1024;
const MAX_LIMIT = 500;

export type ValidationDetail = {
  field: string;
  message: string;
};

export type RecordUtilityMeterReadingBody = {
  readingValue: number;
  readingAt: Date;
  uomId?: string;
  source?: UtilityMeterReadingSource;
  readingType?: UtilityMeterReadingType;
  notes?: string | null;
  tenantCompanyId?: string;
  meterReadingBindingId?: string | null;
  formInstanceId?: string | null;
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

export function parseUtilityMeterReadingIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter reading id');
}

export function parseReadingMeterIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter id');
}

export function parseReadingBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseReadingTenantIdParam(raw: string): string {
  return parseUuidParam(raw, 'tenantCompanyId', 'Tenant company id');
}

export function parseRecordUtilityMeterReadingBody(
  body: unknown,
): RecordUtilityMeterReadingBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const readingValue = readReadingValue(body.readingValue, details);
  const readingAt = readRequiredDate(body.readingAt, 'readingAt', details);
  const uomId = readOptionalUuid(body.uomId, 'uomId', 'UOM id', details);
  const source = readSource(body.source, details);
  const readingType = readReadingType(body.readingType, details);
  const notes = readNullableNotes(body.notes, details);
  const tenantCompanyId = readOptionalUuid(
    body.tenantCompanyId,
    'tenantCompanyId',
    'Tenant company id',
    details,
  );
  const meterReadingBindingId = readOptionalUuid(
    body.meterReadingBindingId,
    'meterReadingBindingId',
    'Meter reading binding id',
    details,
  );
  const formInstanceId = readOptionalUuid(
    body.formInstanceId,
    'formInstanceId',
    'Form instance id',
    details,
  );

  if (readingValue === undefined || readingAt === undefined || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    readingValue,
    readingAt,
    ...(uomId === undefined ? {} : { uomId }),
    ...(source === undefined ? {} : { source }),
    ...(readingType === undefined ? {} : { readingType }),
    ...(notes === undefined ? {} : { notes }),
    ...(tenantCompanyId === undefined ? {} : { tenantCompanyId }),
    ...(meterReadingBindingId === undefined ? {} : { meterReadingBindingId }),
    ...(formInstanceId === undefined ? {} : { formInstanceId }),
  };
}

export function parseReadingSourceQuery(
  raw: string | undefined,
): UtilityMeterReadingSource | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityMeterReadingSource(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'source',
        message: `Source must be one of: ${UTILITY_METER_READING_SOURCES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseReadingTypeQuery(
  raw: string | undefined,
): UtilityMeterReadingType | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityMeterReadingType(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'readingType',
        message: `Reading type must be one of: ${UTILITY_METER_READING_TYPES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseReadingDateQuery(
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

export function parseReadingUuidQuery(
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

export function parseReadingLimitQuery(
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

/**
 * A reading must be a finite, non-negative number. Meters do not run
 * backwards, and a NaN / Infinity value would corrupt every later
 * consumption calculation (BE-18G).
 */
function readReadingValue(
  value: unknown,
  details: ValidationDetail[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    details.push({
      field: 'readingValue',
      message: 'Reading value is required and must be a finite number.',
    });
    return undefined;
  }
  if (value < 0) {
    details.push({
      field: 'readingValue',
      message: 'Reading value must not be negative.',
    });
    return undefined;
  }
  return value;
}

function readRequiredDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({
      field,
      message: `${field} is required and must be a valid ISO-8601 date string.`,
    });
    return undefined;
  }
  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date string.`,
    });
    return undefined;
  }
  return date;
}

function readSource(
  value: unknown,
  details: ValidationDetail[],
): UtilityMeterReadingSource | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'source', message: 'Source must be a string.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isUtilityMeterReadingSource(normalized)) {
    details.push({
      field: 'source',
      message: `Source must be one of: ${UTILITY_METER_READING_SOURCES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readReadingType(
  value: unknown,
  details: ValidationDetail[],
): UtilityMeterReadingType | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({
      field: 'readingType',
      message: 'Reading type must be a string.',
    });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isUtilityMeterReadingType(normalized)) {
    details.push({
      field: 'readingType',
      message: `Reading type must be one of: ${UTILITY_METER_READING_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
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

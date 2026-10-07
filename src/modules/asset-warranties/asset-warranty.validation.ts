import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ASSET_WARRANTY_STATUSES,
  isAssetWarrantyStatus,
  type AssetWarrantyStatus,
  type CreateAssetWarrantyInput,
  type UpdateAssetWarrantyInput,
  type UpdateAssetWarrantyStatusInput,
} from './asset-warranty.types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MAX_PROVIDER_NAME_LENGTH = 160;
const MAX_WARRANTY_NUMBER_LENGTH = 120;
const MAX_COVERAGE_DESCRIPTION_LENGTH = 2048;

export type ValidationDetail = {
  field: string;
  message: string;
};

/**
 * Warranty numbers come from the provider's document, so they are NOT forced
 * into the internal code shape: they keep their original case and may
 * contain dots, slashes, and spaces. Only trimmed and length-checked.
 */
export function normalizeWarrantyNumber(warrantyNumber: string): string {
  return warrantyNumber.trim();
}

/** True for a real `YYYY-MM-DD` calendar date (rejects 2023-02-29). */
export function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return date.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWarrantyAssetIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'assetId', message: 'Asset id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseWarrantyIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'warrantyId', message: 'Warranty id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

/** Optional `?status=` filter on the warranty history route. */
export function parseWarrantyStatusQuery(
  raw: unknown,
): AssetWarrantyStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Array.isArray(raw) ? '' : String(raw).trim().toUpperCase();
  if (value === '') {
    return undefined;
  }

  if (!isAssetWarrantyStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${ASSET_WARRANTY_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return value;
}

export function parseCreateAssetWarrantyBody(
  body: unknown,
): Omit<CreateAssetWarrantyInput, 'assetId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const providerName = readRequiredText(
    body.providerName,
    'providerName',
    MAX_PROVIDER_NAME_LENGTH,
    details,
  );
  const warrantyNumber = readRequiredText(
    body.warrantyNumber,
    'warrantyNumber',
    MAX_WARRANTY_NUMBER_LENGTH,
    details,
  );
  const startDate = readRequiredDate(body.startDate, 'startDate', details);
  const endDate = readRequiredDate(body.endDate, 'endDate', details);
  const coverageDescription = readOptionalText(
    body.coverageDescription,
    'coverageDescription',
    MAX_COVERAGE_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  assertDateRange(startDate, endDate, details);

  if (!providerName || !warrantyNumber || !startDate || !endDate) {
    throw AppError.validation('Request validation failed.', details);
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    providerName,
    warrantyNumber,
    startDate,
    endDate,
    ...(coverageDescription === undefined ? {} : { coverageDescription }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateAssetWarrantyBody(
  body: unknown,
): UpdateAssetWarrantyInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const providerName =
    body.providerName === undefined
      ? undefined
      : readRequiredText(
          body.providerName,
          'providerName',
          MAX_PROVIDER_NAME_LENGTH,
          details,
        );
  const warrantyNumber =
    body.warrantyNumber === undefined
      ? undefined
      : readRequiredText(
          body.warrantyNumber,
          'warrantyNumber',
          MAX_WARRANTY_NUMBER_LENGTH,
          details,
        );
  const startDate =
    body.startDate === undefined
      ? undefined
      : readRequiredDate(body.startDate, 'startDate', details);
  const endDate =
    body.endDate === undefined
      ? undefined
      : readRequiredDate(body.endDate, 'endDate', details);
  const coverageDescription = readNullableText(
    body.coverageDescription,
    'coverageDescription',
    MAX_COVERAGE_DESCRIPTION_LENGTH,
    details,
  );
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(providerName === undefined ? {} : { providerName }),
    ...(warrantyNumber === undefined ? {} : { warrantyNumber }),
    ...(startDate === undefined ? {} : { startDate }),
    ...(endDate === undefined ? {} : { endDate }),
    ...(coverageDescription === undefined ? {} : { coverageDescription }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateAssetWarrantyStatusBody(
  body: unknown,
): UpdateAssetWarrantyStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${ASSET_WARRANTY_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

/** Coverage cannot end before it begins. Mirrors the DB CHECK constraint. */
export function assertDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
  details: ValidationDetail[],
): void {
  if (startDate && endDate && endDate < startDate) {
    details.push({
      field: 'endDate',
      message: 'endDate cannot be earlier than startDate.',
    });
  }
}

function readRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }

  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readRequiredDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidCalendarDate(value.trim())) {
    details.push({
      field,
      message: `${field} must be a valid calendar date in YYYY-MM-DD format.`,
    });
    return undefined;
  }

  return value.trim();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): AssetWarrantyStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isAssetWarrantyStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${ASSET_WARRANTY_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

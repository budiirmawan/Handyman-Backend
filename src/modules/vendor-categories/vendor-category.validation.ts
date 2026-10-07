import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_CATEGORY_STATUSES,
  isVendorCategoryStatus,
  type CreateVendorCategoryInput,
  type UpdateVendorCategoryInput,
  type UpdateVendorCategoryStatusInput,
  type VendorCategoryStatus,
} from './vendor-category.types';

/**
 * Vendor Category codes are the stable machine-readable identifier (e.g.
 * `ENGINEERING`, `HOUSEKEEPING`, `FIRE_PROTECTION`). Normalized to uppercase,
 * matching every other code in the system: start with a letter; letters,
 * digits, hyphens, underscores. Codes are reference DATA — never behavior.
 */
const VENDOR_CATEGORY_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_VENDOR_CATEGORY_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeVendorCategoryCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidVendorCategoryCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_VENDOR_CATEGORY_CODE_LENGTH &&
    VENDOR_CATEGORY_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorCategoryIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'vendorCategoryId',
        message: 'Vendor category id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseVendorCategoryClientIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVendorCategoryBody(
  body: unknown,
): Omit<CreateVendorCategoryInput, 'clientId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVendorCategoryBody(
  body: unknown,
): UpdateVendorCategoryInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.clientId !== undefined || body.code !== undefined) {
    throw AppError.validation('Request validation failed.', [
      {
        field: body.clientId !== undefined ? 'clientId' : 'code',
        message: 'This field is immutable and cannot be updated.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name =
    body.name === undefined ? undefined : readName(body.name, details);
  const description =
    body.description === null
      ? null
      : readOptionalString(
          body.description,
          'description',
          MAX_DESCRIPTION_LENGTH,
          details,
        );
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVendorCategoryStatusBody(
  body: unknown,
): UpdateVendorCategoryStatusInput {
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
        message: `Status must be one of: ${VENDOR_CATEGORY_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Vendor category code is required.' });
    return undefined;
  }

  const normalized = normalizeVendorCategoryCode(value);
  if (!isValidVendorCategoryCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Vendor category code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Vendor category name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Vendor category name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Vendor category name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readOptionalString(
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VendorCategoryStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isVendorCategoryStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${VENDOR_CATEGORY_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

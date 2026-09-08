import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_STATUSES,
  isVendorStatus,
  type CreateVendorInput,
  type UpdateVendorInput,
  type UpdateVendorStatusInput,
  type VendorStatus,
} from './vendor.types';

/**
 * Vendor codes are the stable machine-readable identifier (e.g.
 * `VND_CLEANING_01`). Normalized to uppercase, matching every other code in
 * the system: start with a letter; letters, digits, hyphens, underscores.
 */
const VENDOR_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_VENDOR_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_LEGAL_NAME_LENGTH = 255;
const MAX_REGISTRATION_NUMBER_LENGTH = 64;
const MAX_TAX_NUMBER_LENGTH = 64;
const MAX_EMAIL_LENGTH = 255;
const MAX_PHONE_LENGTH = 32;
const MAX_ADDRESS_LENGTH = 512;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9()\-\s.]{5,}$/;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeVendorCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidVendorCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_VENDOR_CODE_LENGTH &&
    VENDOR_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'vendorId', message: 'Vendor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseVendorClientIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVendorBody(
  body: unknown,
): Omit<CreateVendorInput, 'clientId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const vendorCode = readVendorCode(body.vendorCode, details);
  const vendorName = readVendorName(body.vendorName, details);
  const legalName = readOptionalString(
    body.legalName,
    'legalName',
    MAX_LEGAL_NAME_LENGTH,
    details,
  );
  const registrationNumber = readOptionalString(
    body.registrationNumber,
    'registrationNumber',
    MAX_REGISTRATION_NUMBER_LENGTH,
    details,
  );
  const taxNumber = readOptionalString(
    body.taxNumber,
    'taxNumber',
    MAX_TAX_NUMBER_LENGTH,
    details,
  );
  const email = readOptionalEmail(body.email, details);
  const phone = readOptionalPhone(body.phone, details);
  const address = readOptionalString(
    body.address,
    'address',
    MAX_ADDRESS_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  if (!vendorCode || !vendorName || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    vendorCode,
    vendorName,
    ...(legalName === undefined ? {} : { legalName }),
    ...(registrationNumber === undefined ? {} : { registrationNumber }),
    ...(taxNumber === undefined ? {} : { taxNumber }),
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(address === undefined ? {} : { address }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVendorBody(body: unknown): UpdateVendorInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.clientId !== undefined || body.vendorCode !== undefined) {
    throw AppError.validation('Request validation failed.', [
      {
        field: body.clientId !== undefined ? 'clientId' : 'vendorCode',
        message: 'This field is immutable and cannot be updated.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];

  const vendorName =
    body.vendorName === undefined
      ? undefined
      : readVendorName(body.vendorName, details);
  const legalName = readNullableString(
    body.legalName,
    'legalName',
    MAX_LEGAL_NAME_LENGTH,
    details,
  );
  const registrationNumber = readNullableString(
    body.registrationNumber,
    'registrationNumber',
    MAX_REGISTRATION_NUMBER_LENGTH,
    details,
  );
  const taxNumber = readNullableString(
    body.taxNumber,
    'taxNumber',
    MAX_TAX_NUMBER_LENGTH,
    details,
  );
  const email =
    body.email === null ? null : readOptionalEmail(body.email, details);
  const phone =
    body.phone === null ? null : readOptionalPhone(body.phone, details);
  const address = readNullableString(
    body.address,
    'address',
    MAX_ADDRESS_LENGTH,
    details,
  );
  const vendorCategoryId =
    body.vendorCategoryId === undefined
      ? undefined
      : readVendorCategoryId(body.vendorCategoryId, details);
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(vendorName === undefined ? {} : { vendorName }),
    ...(legalName === undefined ? {} : { legalName }),
    ...(registrationNumber === undefined ? {} : { registrationNumber }),
    ...(taxNumber === undefined ? {} : { taxNumber }),
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(address === undefined ? {} : { address }),
    ...(vendorCategoryId === undefined ? {} : { vendorCategoryId }),
    ...(status === undefined ? {} : { status }),
  };
}

/** `vendorCategoryId` assigns a classification; explicit null clears it. */
function readVendorCategoryId(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'vendorCategoryId',
      message: 'vendorCategoryId must be a valid UUID or null.',
    });
    return undefined;
  }

  return value.trim().toLowerCase();
}

export function parseUpdateVendorStatusBody(
  body: unknown,
): UpdateVendorStatusInput {
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
        message: `Status must be one of: ${VENDOR_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readVendorCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'vendorCode', message: 'Vendor code is required.' });
    return undefined;
  }

  const normalized = normalizeVendorCode(value);
  if (!isValidVendorCode(normalized)) {
    details.push({
      field: 'vendorCode',
      message:
        'Vendor code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readVendorName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'vendorName', message: 'Vendor name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'vendorName', message: 'Vendor name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'vendorName',
      message: `Vendor name must be at most ${MAX_NAME_LENGTH} characters.`,
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

/** Like readOptionalString, but `null` explicitly clears the field. */
function readNullableString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readOptionalString(value, field, maxLength, details);
}

function readOptionalEmail(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  const email = readOptionalString(value, 'email', MAX_EMAIL_LENGTH, details);
  if (email === undefined) {
    return undefined;
  }

  const normalized = email.toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    details.push({ field: 'email', message: 'email must be a valid email address.' });
    return undefined;
  }

  return normalized;
}

function readOptionalPhone(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  const phone = readOptionalString(value, 'phone', MAX_PHONE_LENGTH, details);
  if (phone === undefined) {
    return undefined;
  }

  if (!PHONE_PATTERN.test(phone)) {
    details.push({
      field: 'phone',
      message:
        'phone may contain only digits, spaces, parentheses, dots, hyphens, and an optional leading +.',
    });
    return undefined;
  }

  return phone;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VendorStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isVendorStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${VENDOR_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

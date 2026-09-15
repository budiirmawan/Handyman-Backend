import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_PIC_STATUSES,
  isVendorPicStatus,
  type CreateVendorPicInput,
  type UpdateVendorPicInput,
  type UpdateVendorPicStatusInput,
  type VendorPicStatus,
} from './vendor-pic.types';

const MAX_NAME_LENGTH = 160;
const MAX_POSITION_LENGTH = 128;
const MAX_EMAIL_LENGTH = 255;
const MAX_PHONE_LENGTH = 32;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9()\-\s.]{5,}$/;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorPicIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'vendorPicId', message: 'Vendor PIC id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseVendorPicVendorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'vendorId', message: 'Vendor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVendorPicBody(
  body: unknown,
): Omit<CreateVendorPicInput, 'vendorId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = readName(body.name, details);
  const position = readOptionalString(
    body.position,
    'position',
    MAX_POSITION_LENGTH,
    details,
  );
  const email = readOptionalEmail(body.email, details);
  const phone = readOptionalPhone(body.phone, details);
  const isPrimary = readIsPrimary(body.isPrimary, details);
  const status = readStatus(body.status, details);

  if (!name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    name,
    ...(position === undefined ? {} : { position }),
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(isPrimary === undefined ? {} : { isPrimary }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVendorPicBody(body: unknown): UpdateVendorPicInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.vendorId !== undefined) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'vendorId',
        message: 'This field is immutable and cannot be updated.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const position =
    body.position === null
      ? null
      : readOptionalString(body.position, 'position', MAX_POSITION_LENGTH, details);
  const email = body.email === null ? null : readOptionalEmail(body.email, details);
  const phone = body.phone === null ? null : readOptionalPhone(body.phone, details);
  const isPrimary = readIsPrimary(body.isPrimary, details);
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(position === undefined ? {} : { position }),
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(isPrimary === undefined ? {} : { isPrimary }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVendorPicStatusBody(
  body: unknown,
): UpdateVendorPicStatusInput {
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
        message: `Status must be one of: ${VENDOR_PIC_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'PIC name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'PIC name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `PIC name must be at most ${MAX_NAME_LENGTH} characters.`,
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

function readIsPrimary(
  value: unknown,
  details: ValidationDetail[],
): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'boolean') {
    details.push({ field: 'isPrimary', message: 'isPrimary must be a boolean.' });
    return undefined;
  }

  return value;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VendorPicStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isVendorPicStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${VENDOR_PIC_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

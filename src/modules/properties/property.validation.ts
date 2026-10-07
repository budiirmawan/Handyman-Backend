import { AppError } from '../../shared/errors';
import {
  isValidUuid,
  parseClientIdParam,
} from '../clients';
import {
  PROPERTY_STATUSES,
  isPropertyStatus,
  type CreatePropertyInput,
  type PropertyStatus,
  type UpdatePropertyStatusInput,
} from './property.types';

/**
 * Property codes are the stable machine-readable identifier (e.g.
 * `JKT_SOUTH_01`). They are normalized to uppercase and allow letters, digits,
 * hyphens, and underscores.
 */
const PROPERTY_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_PROPERTY_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_LINE_LENGTH = 255;
const MAX_CITY_LENGTH = 128;
const MAX_PROVINCE_LENGTH = 128;
const MAX_POSTAL_CODE_LENGTH = 32;
const MAX_COUNTRY_CODE_LENGTH = 8;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizePropertyCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidPropertyCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_PROPERTY_CODE_LENGTH &&
    PROPERTY_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePropertyIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'propertyId', message: 'Property id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parsePropertyClientIdParam(raw: string): string {
  return parseClientIdParam(raw);
}

export function parseCreatePropertyBody(body: unknown): CreatePropertyInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const clientId = readClientId(body.clientId, details);
  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const status = readStatus(body.status, details);
  const addressLine = readOptionalString(body.addressLine, 'addressLine', MAX_LINE_LENGTH, details);
  const city = readOptionalString(body.city, 'city', MAX_CITY_LENGTH, details);
  const province = readOptionalString(body.province, 'province', MAX_PROVINCE_LENGTH, details);
  const postalCode = readOptionalString(body.postalCode, 'postalCode', MAX_POSTAL_CODE_LENGTH, details);
  const countryCode = readOptionalString(body.countryCode, 'countryCode', MAX_COUNTRY_CODE_LENGTH, details);

  if (!clientId || !code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    clientId,
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
    ...(addressLine === undefined ? {} : { addressLine }),
    ...(city === undefined ? {} : { city }),
    ...(province === undefined ? {} : { province }),
    ...(postalCode === undefined ? {} : { postalCode }),
    ...(countryCode === undefined ? {} : { countryCode }),
  };
}

export function parseUpdatePropertyStatusBody(
  body: unknown,
): UpdatePropertyStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      { field: 'status', message: `Status must be one of: ${PROPERTY_STATUSES.join(', ')}.` },
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
    details.push({ field: 'code', message: 'Property code is required.' });
    return undefined;
  }

  const normalized = normalizePropertyCode(value);
  if (!isValidPropertyCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Property code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Property name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Property name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Property name must be at most ${MAX_NAME_LENGTH} characters.`,
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
): PropertyStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPropertyStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${PROPERTY_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

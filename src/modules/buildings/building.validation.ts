import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { parsePropertyIdParam } from '../properties';
import {
  BUILDING_STATUSES,
  isBuildingStatus,
  type BuildingStatus,
  type CreateBuildingInput,
  type UpdateBuildingStatusInput,
} from './building.types';

/**
 * Building codes are the stable machine-readable identifier (e.g. `TOWER_A`).
 * They are normalized to uppercase and allow letters, digits, hyphens, and
 * underscores.
 */
const BUILDING_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_BUILDING_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_LINE_LENGTH = 255;
const MAX_CITY_LENGTH = 128;
const MAX_PROVINCE_LENGTH = 128;
const MAX_POSTAL_CODE_LENGTH = 32;
const MAX_COUNTRY_CODE_LENGTH = 8;
const MAX_TIMEZONE_LENGTH = 128;

let validTimeZones: ReadonlySet<string> | null = null;

function getValidTimeZones(): ReadonlySet<string> {
  if (!validTimeZones) {
    // Intl.supportedValuesOf is available on Node 22 (runtime >=20 for this repo).
    const values: string[] = Intl.supportedValuesOf
      ? Intl.supportedValuesOf('timeZone')
      : [];
    validTimeZones = new Set(values);
  }
  return validTimeZones;
}

export function isValidTimeZone(value: string): boolean {
  return getValidTimeZones().has(value);
}

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeBuildingCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidBuildingCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_BUILDING_CODE_LENGTH &&
    BUILDING_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseBuildingPropertyIdParam(raw: string): string {
  return parsePropertyIdParam(raw);
}

export function parseCreateBuildingBody(body: unknown): CreateBuildingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const propertyId = readPropertyId(body.propertyId, details);
  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const status = readStatus(body.status, details);
  const addressLine = readOptionalString(body.addressLine, 'addressLine', MAX_LINE_LENGTH, details);
  const city = readOptionalString(body.city, 'city', MAX_CITY_LENGTH, details);
  const province = readOptionalString(body.province, 'province', MAX_PROVINCE_LENGTH, details);
  const postalCode = readOptionalString(body.postalCode, 'postalCode', MAX_POSTAL_CODE_LENGTH, details);
  const countryCode = readOptionalString(body.countryCode, 'countryCode', MAX_COUNTRY_CODE_LENGTH, details);
  const timezone = readTimeZone(body.timezone, details);

  if (!propertyId || !code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    propertyId,
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
    ...(addressLine === undefined ? {} : { addressLine }),
    ...(city === undefined ? {} : { city }),
    ...(province === undefined ? {} : { province }),
    ...(postalCode === undefined ? {} : { postalCode }),
    ...(countryCode === undefined ? {} : { countryCode }),
    ...(timezone === undefined ? {} : { timezone }),
  };
}

export function parseUpdateBuildingStatusBody(
  body: unknown,
): UpdateBuildingStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      { field: 'status', message: `Status must be one of: ${BUILDING_STATUSES.join(', ')}.` },
    ]);
  }

  return { status };
}

function readPropertyId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field: 'propertyId', message: 'propertyId is required and must be a valid UUID.' });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Building code is required.' });
    return undefined;
  }

  const normalized = normalizeBuildingCode(value);
  if (!isValidBuildingCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Building code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Building name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Building name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Building name must be at most ${MAX_NAME_LENGTH} characters.`,
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

function readTimeZone(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({ field: 'timezone', message: 'timezone must be a string.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.length > MAX_TIMEZONE_LENGTH) {
    details.push({
      field: 'timezone',
      message: `timezone must be at most ${MAX_TIMEZONE_LENGTH} characters.`,
    });
    return undefined;
  }

  if (!isValidTimeZone(trimmed)) {
    details.push({ field: 'timezone', message: 'timezone must be a valid IANA timezone (e.g. Asia/Jakarta).' });
    return undefined;
  }

  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): BuildingStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isBuildingStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${BUILDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

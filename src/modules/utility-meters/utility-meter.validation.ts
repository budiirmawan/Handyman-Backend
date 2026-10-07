import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  UTILITY_METER_PURPOSES,
  UTILITY_METER_STATUSES,
  UTILITY_TYPES,
  isUtilityMeterPurpose,
  isUtilityMeterStatus,
  isUtilityType,
  type CreateUtilityMeterInput,
  type UpdateUtilityMeterInput,
  type UpdateUtilityMeterStatusInput,
  type UtilityMeterStatus,
  type UtilityType,
} from './utility-meter.types';

/** BE-18A — Meter Master request validation. */

const CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_SERIAL_NUMBER_LENGTH = 128;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeUtilityMeterCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidUtilityMeterCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    CODE_PATTERN.test(code)
  );
}

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

export function parseUtilityMeterIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter id');
}

export function parseUtilityMeterBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseUtilityMeterClientIdParam(raw: string): string {
  return parseUuidParam(raw, 'clientId', 'Client id');
}

export function parseCreateUtilityMeterBody(
  body: unknown,
): Omit<CreateUtilityMeterInput, 'buildingId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const utilityType = readUtilityType(body.utilityType, details);
  const purpose = body.purpose === undefined ? undefined : readPurpose(body.purpose, details);
  const uomId = readRequiredUomId(body.uomId, details);
  const spaceId = readOptionalUuid(body.spaceId, 'spaceId', 'Space id', details);
  const functionalLocationId = readOptionalUuid(
    body.functionalLocationId,
    'functionalLocationId',
    'Functional location id',
    details,
  );
  const serialNumber = readNullableSerialNumber(body.serialNumber, details);
  const status = readOptionalStatus(body.status, details);

  if (!code || !name || !utilityType || !uomId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    utilityType,
    ...(purpose === undefined ? {} : { purpose }),
    uomId,
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(serialNumber === undefined ? {} : { serialNumber }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateUtilityMeterBody(body: unknown): UpdateUtilityMeterInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const utilityType =
    body.utilityType === undefined
      ? undefined
      : readUtilityType(body.utilityType, details);
  const uomId =
    body.uomId === undefined ? undefined : readRequiredUomId(body.uomId, details);
  const spaceId =
    body.spaceId === undefined
      ? undefined
      : readNullableUuid(body.spaceId, 'spaceId', 'Space id', details);
  const functionalLocationId =
    body.functionalLocationId === undefined
      ? undefined
      : readNullableUuid(
          body.functionalLocationId,
          'functionalLocationId',
          'Functional location id',
          details,
        );
  const serialNumber =
    body.serialNumber === undefined
      ? undefined
      : readNullableSerialNumber(body.serialNumber, details);
  const status =
    body.status === undefined ? undefined : readOptionalStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(utilityType === undefined ? {} : { utilityType }),
    ...(uomId === undefined ? {} : { uomId }),
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(functionalLocationId === undefined ? {} : { functionalLocationId }),
    ...(serialNumber === undefined ? {} : { serialNumber }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateUtilityMeterStatusBody(
  body: unknown,
): UpdateUtilityMeterStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (!isUtilityMeterStatus(body.status)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${UTILITY_METER_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status: body.status };
}

/** Optional query filter parsers (unknown values are rejected, never ignored). */

export function parseUtilityMeterStatusQuery(
  raw: string | undefined,
): UtilityMeterStatus | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityMeterStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${UTILITY_METER_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseUtilityTypeQuery(
  raw: string | undefined,
): UtilityType | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityType(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'utilityType',
        message: `Utility type must be one of: ${UTILITY_TYPES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseUtilityMeterUuidQuery(
  raw: string | undefined,
  field: string,
  label: string,
): string | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  return parseUuidParam(raw, field, label);
}

export function parseUtilityMeterSearchQuery(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function readPurpose(value: unknown, details: ValidationDetail[]) {
  if (!isUtilityMeterPurpose(value)) {
    details.push({ field: 'purpose', message: `Meter purpose must be one of: ${UTILITY_METER_PURPOSES.join(', ')}.` });
    return undefined;
  }
  return value;
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Meter code is required.' });
    return undefined;
  }
  const normalized = normalizeUtilityMeterCode(value);
  if (!isValidUtilityMeterCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Meter code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }
  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Meter name is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Meter name is required.' });
    return undefined;
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Meter name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readUtilityType(
  value: unknown,
  details: ValidationDetail[],
): UtilityType | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'utilityType', message: 'Utility type is required.' });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (!isUtilityType(normalized)) {
    details.push({
      field: 'utilityType',
      message: `Utility type must be one of: ${UTILITY_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readRequiredUomId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'uomId', message: 'UOM id is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (!isValidUuid(trimmed)) {
    details.push({ field: 'uomId', message: 'UOM id must be a valid UUID.' });
    return undefined;
  }
  return trimmed.toLowerCase();
}

function readOptionalUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return trimmed.toLowerCase();
}

function readNullableUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${label} must be a valid UUID or null.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${label} must be a valid UUID or null.` });
    return undefined;
  }
  return trimmed.toLowerCase();
}

function readNullableSerialNumber(
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
    details.push({
      field: 'serialNumber',
      message: 'Serial number must be a string or null.',
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > MAX_SERIAL_NUMBER_LENGTH) {
    details.push({
      field: 'serialNumber',
      message: `Serial number must be at most ${MAX_SERIAL_NUMBER_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalStatus(
  value: unknown,
  details: ValidationDetail[],
): UtilityMeterStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isUtilityMeterStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${UTILITY_METER_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

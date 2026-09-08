import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  CLEANING_AREA_STATUSES,
  CLEANING_AREA_TYPES,
  isCleaningAreaStatus,
  isCleaningAreaType,
  type CleaningAreaFilter,
  type CleaningAreaStatus,
  type CleaningAreaType,
  type CreateCleaningAreaInput,
  type UpdateCleaningAreaInput,
} from './cleaning-area.types';

const CLEANING_AREA_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeCleaningAreaCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidCleaningAreaCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    CLEANING_AREA_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCleaningAreaIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Cleaning area id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCleaningAreaBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateCleaningAreaBody(
  body: unknown,
): Omit<CreateCleaningAreaInput, 'buildingId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const cleaningAreaType = readCleaningAreaType(body.cleaningAreaType ?? body.type, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  const floorId = readOptionalUuid(body.floorId, 'floorId', details);
  const areaId = readOptionalUuid(body.areaId, 'areaId', details);
  const roomId = readOptionalUuid(body.roomId, 'roomId', details);
  const spaceId = readOptionalUuid(body.spaceId, 'spaceId', details);
  const functionalLocationId = readOptionalUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(cleaningAreaType !== undefined ? { cleaningAreaType } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(floorId !== undefined ? { floorId } : {}),
    ...(areaId !== undefined ? { areaId } : {}),
    ...(roomId !== undefined ? { roomId } : {}),
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(functionalLocationId !== undefined ? { functionalLocationId } : {}),
  };
}

export function parseUpdateCleaningAreaBody(
  body: unknown,
): UpdateCleaningAreaInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const cleaningAreaType =
    body.cleaningAreaType === undefined && body.type === undefined
      ? undefined
      : readCleaningAreaType(body.cleaningAreaType ?? body.type, details);
  const description =
    body.description === undefined
      ? undefined
      : readOptionalString(
          body.description,
          'description',
          MAX_DESCRIPTION_LENGTH,
          details,
        );
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  const floorId =
    body.floorId === undefined
      ? undefined
      : readOptionalUuid(body.floorId, 'floorId', details);
  const areaId =
    body.areaId === undefined
      ? undefined
      : readOptionalUuid(body.areaId, 'areaId', details);
  const roomId =
    body.roomId === undefined
      ? undefined
      : readOptionalUuid(body.roomId, 'roomId', details);
  const spaceId =
    body.spaceId === undefined
      ? undefined
      : readOptionalUuid(body.spaceId, 'spaceId', details);
  const functionalLocationId =
    body.functionalLocationId === undefined
      ? undefined
      : readOptionalUuid(
          body.functionalLocationId,
          'functionalLocationId',
          details,
        );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(cleaningAreaType !== undefined ? { cleaningAreaType } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(floorId !== undefined ? { floorId } : {}),
    ...(areaId !== undefined ? { areaId } : {}),
    ...(roomId !== undefined ? { roomId } : {}),
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(functionalLocationId !== undefined ? { functionalLocationId } : {}),
  };
}

export function parseCleaningAreaFilter(
  query: Record<string, unknown>,
): CleaningAreaFilter {
  const details: ValidationDetail[] = [];

  const status =
    query.status === undefined ? undefined : readStatus(query.status, details);
  const cleaningAreaType =
    query.cleaningAreaType === undefined && query.type === undefined
      ? undefined
      : readCleaningAreaType(query.cleaningAreaType ?? query.type, details);

  const floorId =
    query.floorId === undefined
      ? undefined
      : readOptionalUuid(query.floorId, 'floorId', details);
  const areaId =
    query.areaId === undefined
      ? undefined
      : readOptionalUuid(query.areaId, 'areaId', details);
  const roomId =
    query.roomId === undefined
      ? undefined
      : readOptionalUuid(query.roomId, 'roomId', details);
  const spaceId =
    query.spaceId === undefined
      ? undefined
      : readOptionalUuid(query.spaceId, 'spaceId', details);
  const functionalLocationId =
    query.functionalLocationId === undefined
      ? undefined
      : readOptionalUuid(
          query.functionalLocationId,
          'functionalLocationId',
          details,
        );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status !== undefined ? { status } : {}),
    ...(cleaningAreaType !== undefined ? { cleaningAreaType } : {}),
    ...(floorId !== undefined && floorId !== null ? { floorId } : {}),
    ...(areaId !== undefined && areaId !== null ? { areaId } : {}),
    ...(roomId !== undefined && roomId !== null ? { roomId } : {}),
    ...(spaceId !== undefined && spaceId !== null ? { spaceId } : {}),
    ...(functionalLocationId !== undefined && functionalLocationId !== null
      ? { functionalLocationId }
      : {}),
  };
}

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Cleaning area code is required.' });
    return undefined;
  }

  const normalized = normalizeCleaningAreaCode(value);
  if (!isValidCleaningAreaCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Cleaning area code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
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
    details.push({ field: 'name', message: 'Cleaning area name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Cleaning area name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Cleaning area name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readCleaningAreaType(
  value: unknown,
  details: ValidationDetail[],
): CleaningAreaType | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isCleaningAreaType(value)) {
    details.push({
      field: 'cleaningAreaType',
      message: `Cleaning area type must be one of: ${CLEANING_AREA_TYPES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readOptionalString(
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
    details.push({ field, message: `${field} must be a string.` });
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

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null || value === '') {
    return null;
  }

  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }

  return value.trim().toLowerCase();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): CleaningAreaStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isCleaningAreaStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${CLEANING_AREA_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

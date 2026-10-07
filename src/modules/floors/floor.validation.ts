import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  FLOOR_STATUSES,
  isFloorStatus,
  type CreateFloorInput,
  type FloorStatus,
  type UpdateFloorInput,
  type UpdateFloorStatusInput,
} from './floor.types';

/**
 * Floor codes are the stable machine-readable identifier (e.g. `L01`, `GF`,
 * `B1`, `MEZZ`). Normalized to uppercase, matching every other code in the
 * system: start with a letter; letters, digits, hyphens, underscores.
 */
const FLOOR_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_FLOOR_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

/**
 * Sanity bounds for `levelNumber`. Generous enough for any real structure
 * (deep basements through supertall towers) while rejecting nonsense.
 */
const MIN_LEVEL_NUMBER = -100;
const MAX_LEVEL_NUMBER = 500;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeFloorCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidFloorCode(code: string): boolean {
  return (
    code.length >= 1 &&
    code.length <= MAX_FLOOR_CODE_LENGTH &&
    FLOOR_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseFloorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'floorId', message: 'Floor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseFloorBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateFloorBody(
  body: unknown,
): Omit<CreateFloorInput, 'buildingId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const levelNumber = readLevelNumber(body.levelNumber, true, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  if (!code || !name || levelNumber === undefined || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    levelNumber,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateFloorBody(body: unknown): UpdateFloorInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const levelNumber =
    body.levelNumber === undefined
      ? undefined
      : readLevelNumber(body.levelNumber, false, details);
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

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(levelNumber === undefined ? {} : { levelNumber }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateFloorStatusBody(
  body: unknown,
): UpdateFloorStatusInput {
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
        message: `Status must be one of: ${FLOOR_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Floor code is required.' });
    return undefined;
  }

  const normalized = normalizeFloorCode(value);
  if (!isValidFloorCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Floor code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (1-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Floor name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Floor name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Floor name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readLevelNumber(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): number | undefined {
  if (value === undefined || value === null) {
    if (required) {
      details.push({
        field: 'levelNumber',
        message: 'levelNumber is required.',
      });
    }
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value)) {
    details.push({
      field: 'levelNumber',
      message: 'levelNumber must be an integer.',
    });
    return undefined;
  }

  if (value < MIN_LEVEL_NUMBER || value > MAX_LEVEL_NUMBER) {
    details.push({
      field: 'levelNumber',
      message: `levelNumber must be between ${MIN_LEVEL_NUMBER} and ${MAX_LEVEL_NUMBER}.`,
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
): FloorStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isFloorStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${FLOOR_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

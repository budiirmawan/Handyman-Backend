import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SPACE_STATUSES,
  isSpaceStatus,
  type CreateSpaceInput,
  type SpaceStatus,
  type UpdateSpaceInput,
  type UpdateSpaceStatusInput,
} from './space.types';

/**
 * Space codes are the stable machine-readable identifier (e.g. `WS-01`,
 * `RACK_A`). Normalized to uppercase, matching every other code in the
 * system: start with a letter; letters, digits, hyphens, underscores.
 */
const SPACE_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_SPACE_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeSpaceCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidSpaceCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_SPACE_CODE_LENGTH &&
    SPACE_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSpaceIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'spaceId', message: 'Space id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseSpaceRoomIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'roomId', message: 'Room id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateSpaceBody(
  body: unknown,
): Omit<CreateSpaceInput, 'roomId'> {
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
  const areaSqm = readAreaSqm(body.areaSqm, details);
  const status = readStatus(body.status, details);

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(areaSqm === undefined ? {} : { areaSqm }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateSpaceBody(body: unknown): UpdateSpaceInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const description =
    body.description === undefined
      ? undefined
      : readOptionalString(
          body.description,
          'description',
          MAX_DESCRIPTION_LENGTH,
          details,
        );
  const areaSqm = body.areaSqm === undefined
    ? undefined : readAreaSqm(body.areaSqm, details);
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(areaSqm === undefined ? {} : { areaSqm }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateSpaceStatusBody(
  body: unknown,
): UpdateSpaceStatusInput {
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
        message: `Status must be one of: ${SPACE_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readAreaSqm(value: unknown, details: ValidationDetail[]): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
    details.push({ field: 'areaSqm', message: 'areaSqm must be a positive finite number or null.' });
    return undefined;
  }
  return value;
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Space code is required.' });
    return undefined;
  }

  const normalized = normalizeSpaceCode(value);
  if (!isValidSpaceCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Space code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Space name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Space name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Space name must be at most ${MAX_NAME_LENGTH} characters.`,
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
): SpaceStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isSpaceStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${SPACE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

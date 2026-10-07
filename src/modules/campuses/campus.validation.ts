import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { parsePropertyIdParam } from '../properties';
import {
  CAMPUS_STATUSES,
  isCampusStatus,
  type CampusStatus,
  type CreateCampusInput,
  type SetBuildingCampusInput,
  type UpdateCampusInput,
  type UpdateCampusStatusInput,
} from './campus.types';

/**
 * Campus codes are the stable machine-readable identifier (e.g.
 * `EAST_CAMPUS`). Normalized to uppercase, matching every other code in the
 * system: start with a letter; letters, digits, hyphens, underscores.
 */
const CAMPUS_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CAMPUS_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeCampusCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidCampusCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CAMPUS_CODE_LENGTH &&
    CAMPUS_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCampusIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'campusId', message: 'Campus id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCampusPropertyIdParam(raw: string): string {
  return parsePropertyIdParam(raw);
}

export function parseCreateCampusBody(
  body: unknown,
): Omit<CreateCampusInput, 'propertyId'> {
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

export function parseUpdateCampusBody(body: unknown): UpdateCampusInput {
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

export function parseUpdateCampusStatusBody(
  body: unknown,
): UpdateCampusStatusInput {
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
        message: `Status must be one of: ${CAMPUS_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

/**
 * `{ campusId: "<uuid>" }` attaches, `{ campusId: null }` detaches. The key
 * must be present — an empty body is a caller mistake, not a detach.
 */
export function parseSetBuildingCampusBody(
  body: unknown,
): SetBuildingCampusInput {
  if (!isRecord(body) || !('campusId' in body)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'campusId',
        message: 'campusId is required (a campus UUID, or null to detach).',
      },
    ]);
  }

  const raw = body.campusId;
  if (raw === null) {
    return { campusId: null };
  }

  if (typeof raw !== 'string' || !isValidUuid(raw.trim())) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'campusId',
        message: 'campusId must be a valid UUID or null.',
      },
    ]);
  }

  return { campusId: raw.trim().toLowerCase() };
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Campus code is required.' });
    return undefined;
  }

  const normalized = normalizeCampusCode(value);
  if (!isValidCampusCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Campus code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Campus name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Campus name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Campus name must be at most ${MAX_NAME_LENGTH} characters.`,
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
): CampusStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isCampusStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${CAMPUS_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

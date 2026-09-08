import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  FUNCTIONAL_LOCATION_STATUSES,
  isFunctionalLocationStatus,
  type CreateFunctionalLocationInput,
  type FunctionalLocationStatus,
  type UpdateFunctionalLocationInput,
  type UpdateFunctionalLocationStatusInput,
} from './functional-location.types';

/**
 * Functional Location codes are the stable machine-readable operational
 * identifier (e.g. `FL-AHU-L2`, `FL_LOBBY_DESK`). Normalized to uppercase,
 * matching every other code in the system: start with a letter; letters,
 * digits, hyphens, underscores.
 */
const FUNCTIONAL_LOCATION_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeFunctionalLocationCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidFunctionalLocationCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    FUNCTIONAL_LOCATION_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseFunctionalLocationIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'functionalLocationId',
        message: 'Functional location id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseFunctionalLocationBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

/** Optional `?spaceId=` filter on the Building list route. */
export function parseSpaceIdQuery(raw: unknown): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Array.isArray(raw) ? '' : String(raw).trim();
  if (value === '') {
    return undefined;
  }

  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'spaceId', message: 'spaceId must be a valid UUID.' },
    ]);
  }

  return value.toLowerCase();
}

export function parseCreateFunctionalLocationBody(
  body: unknown,
): Omit<CreateFunctionalLocationInput, 'buildingId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const spaceId = readOptionalSpaceId(body.spaceId, details);
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
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateFunctionalLocationBody(
  body: unknown,
): UpdateFunctionalLocationInput {
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
  const spaceId =
    body.spaceId === undefined
      ? undefined
      : readNullableSpaceId(body.spaceId, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
    ...(spaceId === undefined ? {} : { spaceId }),
  };
}

export function parseUpdateFunctionalLocationStatusBody(
  body: unknown,
): UpdateFunctionalLocationStatusInput {
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
        message: `Status must be one of: ${FUNCTIONAL_LOCATION_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'code',
      message: 'Functional location code is required.',
    });
    return undefined;
  }

  const normalized = normalizeFunctionalLocationCode(value);
  if (!isValidFunctionalLocationCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Functional location code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'name',
      message: 'Functional location name is required.',
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({
      field: 'name',
      message: 'Functional location name is required.',
    });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Functional location name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

/** Create-body spaceId: optional, but never null (omit for Building level). */
function readOptionalSpaceId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'spaceId',
      message: 'spaceId must be a valid UUID.',
    });
    return undefined;
  }

  return value.trim().toLowerCase();
}

/** Update-body spaceId: a UUID re-pins; explicit null clears the placement. */
function readNullableSpaceId(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'spaceId',
      message: 'spaceId must be a valid UUID or null.',
    });
    return undefined;
  }

  return value.trim().toLowerCase();
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
): FunctionalLocationStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isFunctionalLocationStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${FUNCTIONAL_LOCATION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

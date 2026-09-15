import { AppError } from '../../shared/errors';
import {
  POSITION_STATUSES,
  isPositionStatus,
  type PositionStatus,
} from './position.types';

const POSITION_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizePositionCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidPositionCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    POSITION_CODE_PATTERN.test(code)
  );
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parsePositionIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'positionId', message: 'Position id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseOrganizationIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'organizationId', message: 'Organization id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseDepartmentIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'departmentId', message: 'Department id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CreatePositionBody {
  departmentId?: string;
  code: string;
  name: string;
  description?: string;
  status?: PositionStatus;
}

export interface UpdatePositionBody {
  name?: string;
  description?: string;
  status?: PositionStatus;
}

export function parseCreatePositionBody(body: unknown): CreatePositionBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const departmentId = readOptionalDepartmentId(body.departmentId, details);
  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const status = readStatus(body.status, details);

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(departmentId === undefined ? {} : { departmentId }),
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdatePositionBody(body: unknown): UpdatePositionBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const source = body as Record<string, unknown>;

  const name = source.name === undefined ? undefined : readName(source.name, details);
  const description = source.description === undefined
    ? undefined
    : readOptionalString(source.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const status = source.status === undefined ? undefined : readStatus(source.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

function readOptionalDepartmentId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isValidUuid(String(value))) {
    details.push({ field: 'departmentId', message: 'Department id must be a valid UUID.' });
    return undefined;
  }
  return String(value).toLowerCase();
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Position code is required.' });
    return undefined;
  }

  const normalized = normalizePositionCode(value);
  if (!isValidPositionCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Position code must start with a letter and contain only uppercase letters, digits, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Position name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Position name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Position name must be at most ${MAX_NAME_LENGTH} characters.`,
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
    details.push({ field, message: `${field} must be at most ${maxLength} characters.` });
    return undefined;
  }

  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): PositionStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPositionStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${POSITION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

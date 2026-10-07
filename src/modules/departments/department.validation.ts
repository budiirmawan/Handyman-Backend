import { AppError } from '../../shared/errors';
import {
  DEPARTMENT_STATUSES,
  isDepartmentStatus,
  type DepartmentStatus,
  type CreateDepartmentInput,
  type UpdateDepartmentInput,
} from './department.types';

/**
 * Department codes are the machine-readable identifier within an Organization.
 * They are normalized to uppercase and must be stable and unique per
 * Organization. The database enforces (organization_id, code) uniqueness;
 * validation here enforces format only.
 */
const DEPARTMENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeDepartmentCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidDepartmentCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    DEPARTMENT_CODE_PATTERN.test(code)
  );
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

export function parseOrganizationIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'organizationId', message: 'Organization id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCreateDepartmentBody(body: unknown): CreateDepartmentInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const organizationId = readOrganizationId(body.organizationId, details);
  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const status = readStatus(body.status, details);

  if (!organizationId || !code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    organizationId,
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateDepartmentBody(body: unknown): UpdateDepartmentInput {
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

function readOrganizationId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    details.push({ field: 'organizationId', message: 'Organization id is required.' });
    return undefined;
  }
  if (!isValidUuid(String(value))) {
    details.push({ field: 'organizationId', message: 'Organization id must be a valid UUID.' });
    return undefined;
  }
  return String(value).toLowerCase();
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Department code is required.' });
    return undefined;
  }

  const normalized = normalizeDepartmentCode(value);
  if (!isValidDepartmentCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Department code must start with a letter and contain only uppercase letters, digits, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Department name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Department name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Department name must be at most ${MAX_NAME_LENGTH} characters.`,
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
): DepartmentStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isDepartmentStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${DEPARTMENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

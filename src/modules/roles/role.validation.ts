import { AppError } from '../../shared/errors';
import { parseUserIdParam } from '../users';
import { ROLE_STATUSES, isRoleStatus, type CreateRoleInput, type RoleStatus } from './role.types';

/**
 * Role codes are the machine-readable authorization identifier. They are
 * normalized to uppercase with underscores (e.g. `building_manager` →
 * `BUILDING_MANAGER`) and must match a stable, conservative pattern.
 */
const ROLE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_ROLE_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeRoleCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidRoleCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_ROLE_CODE_LENGTH &&
    ROLE_CODE_PATTERN.test(code)
  );
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseRoleIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'roleId', message: 'Role id must be a valid UUID.' },
    ]);
  }

  return value.toLowerCase();
}

export function parseCreateRoleBody(body: unknown): CreateRoleInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const source = body as Record<string, unknown>;

  const code = readCode(source.code, details);
  const name = readName(source.name, details);
  const description = readDescription(source.description, details);
  const status = readStatus(source.status, details);

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

export function parseAssignRoleBody(body: unknown): { roleId: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const source = body as Record<string, unknown>;
  const rawRoleId = typeof source.roleId === 'string' ? source.roleId : '';

  if (!isValidUuid(rawRoleId.trim())) {
    throw AppError.validation('Request validation failed.', [
      { field: 'roleId', message: 'roleId is required and must be a valid UUID.' },
    ]);
  }

  return { roleId: rawRoleId.trim().toLowerCase() };
}

export function parseRoleUserIdParam(raw: string): string {
  return parseUserIdParam(raw);
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Role code is required.' });
    return undefined;
  }

  const normalized = normalizeRoleCode(value);
  if (!isValidRoleCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Role code must start with a letter and contain only uppercase letters, digits, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Role name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Role name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Role name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readDescription(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({ field: 'description', message: 'Description must be a string.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
    details.push({
      field: 'description',
      message: `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): RoleStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRoleStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${ROLE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

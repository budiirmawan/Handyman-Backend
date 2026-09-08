import { AppError } from '../../shared/errors';
import {
  PERMISSION_STATUSES,
  isPermissionStatus,
  type CreatePermissionInput,
  type PermissionStatus,
} from './permission.types';

/**
 * Permission codes are normalized to lowercase `resource.action` form
 * (e.g. `USER.READ` → `user.read`). Capability, context, and entitlement are
 * deliberately not encoded into the code.
 */
const PERMISSION_SEGMENT_PATTERN = /^[a-z][a-z0-9_]*$/;
const MAX_PERMISSION_CODE_LENGTH = 128;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 512;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizePermissionCode(code: string): string {
  return code.trim().toLowerCase();
}

export function isValidPermissionCode(code: string): boolean {
  if (code.length < 3 || code.length > MAX_PERMISSION_CODE_LENGTH) {
    return false;
  }

  const segments = code.split('.');
  if (segments.length < 2) {
    return false;
  }

  return segments.every((segment) => PERMISSION_SEGMENT_PATTERN.test(segment));
}

export function isValidUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function parsePermissionIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'permissionId', message: 'Permission id must be a valid UUID.' },
    ]);
  }

  return value.toLowerCase();
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

export function parseCreatePermissionBody(body: unknown): CreatePermissionInput {
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

export function parseAssignPermissionBody(
  body: unknown,
): { permissionId: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const source = body as Record<string, unknown>;
  const rawPermissionId =
    typeof source.permissionId === 'string' ? source.permissionId : '';

  if (!isValidUuid(rawPermissionId.trim())) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'permissionId',
        message: 'permissionId is required and must be a valid UUID.',
      },
    ]);
  }

  return { permissionId: rawPermissionId.trim().toLowerCase() };
}

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Permission code is required.' });
    return undefined;
  }

  const normalized = normalizePermissionCode(value);
  if (!isValidPermissionCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Permission code must be a lowercase resource.action (e.g. user.read), 3-128 characters.',
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
    details.push({ field: 'name', message: 'Permission name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Permission name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Permission name must be at most ${MAX_NAME_LENGTH} characters.`,
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
    details.push({
      field: 'description',
      message: 'Description must be a string.',
    });
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
): PermissionStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPermissionStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${PERMISSION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

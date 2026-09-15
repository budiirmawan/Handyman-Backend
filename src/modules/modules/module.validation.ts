import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  MODULE_STATUSES,
  isModuleStatus,
  type CreateModuleInput,
  type ModuleStatus,
  type UpdateModuleStatusInput,
} from './module.types';

/**
 * Module codes are the stable machine-readable identifier (e.g. ENGINEERING,
 * TENANT_SERVICE). They are normalized to uppercase with underscores.
 */
const MODULE_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_MODULE_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeModuleCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidModuleCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_MODULE_CODE_LENGTH &&
    MODULE_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseModuleIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'moduleId', message: 'Module id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateModuleBody(body: unknown): CreateModuleInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
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

export function parseUpdateModuleStatusBody(
  body: unknown,
): UpdateModuleStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      { field: 'status', message: `Status must be one of: ${MODULE_STATUSES.join(', ')}.` },
    ]);
  }

  return { status };
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Module code is required.' });
    return undefined;
  }

  const normalized = normalizeModuleCode(value);
  if (!isValidModuleCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Module code must start with a letter and contain only uppercase letters, digits, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Module name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Module name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Module name must be at most ${MAX_NAME_LENGTH} characters.`,
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
): ModuleStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isModuleStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${MODULE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

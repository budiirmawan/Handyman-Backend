import { AppError } from '../../shared/errors';
import {
  CLIENT_STATUSES,
  isClientStatus,
  type ClientStatus,
  type CreateClientInput,
  type UpdateClientInput,
} from './client.types';

/**
 * Client codes are the machine-readable commercial identifier. They are
 * normalized to uppercase with underscores (e.g. `acme_corp` →
 * `ACME_CORP`) and must match a stable, conservative pattern.
 */
const CLIENT_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const MAX_CLIENT_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_LEGAL_NAME_LENGTH = 255;
const MAX_TAX_ID_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeClientCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidClientCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CLIENT_CODE_LENGTH &&
    CLIENT_CODE_PATTERN.test(code)
  );
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseClientIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be a valid UUID.' },
    ]);
  }

  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCreateClientBody(body: unknown): CreateClientInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const legalName = readOptionalString(body.legalName, 'legalName', MAX_LEGAL_NAME_LENGTH, details);
  const taxId = readOptionalString(body.taxId, 'taxId', MAX_TAX_ID_LENGTH, details);
  const description = readOptionalString(body.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const status = readStatus(body.status, details);

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(legalName === undefined ? {} : { legalName }),
    ...(taxId === undefined ? {} : { taxId }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateClientBody(body: unknown): UpdateClientInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const source = body as Record<string, unknown>;

  const name = source.name === undefined ? undefined : readName(source.name, details);
  const legalName = source.legalName === undefined
    ? undefined
    : readOptionalString(source.legalName, 'legalName', MAX_LEGAL_NAME_LENGTH, details);
  const taxId = source.taxId === undefined
    ? undefined
    : readOptionalString(source.taxId, 'taxId', MAX_TAX_ID_LENGTH, details);
  const description = source.description === undefined
    ? undefined
    : readOptionalString(source.description, 'description', MAX_DESCRIPTION_LENGTH, details);
  const status = source.status === undefined ? undefined : readStatus(source.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(legalName === undefined ? {} : { legalName }),
    ...(taxId === undefined ? {} : { taxId }),
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
  };
}

function readCode(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'code', message: 'Client code is required.' });
    return undefined;
  }

  const normalized = normalizeClientCode(value);
  if (!isValidClientCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Client code must start with a letter and contain only uppercase letters, digits, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Client name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Client name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Client name must be at most ${MAX_NAME_LENGTH} characters.`,
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
): ClientStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isClientStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${CLIENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

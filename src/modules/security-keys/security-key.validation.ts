import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SECURITY_KEY_STATUSES,
  isSecurityKeyStatus,
  type CreateSecurityKeyInput,
  type IssueKeyInput,
  type ReturnKeyInput,
  type SecurityKeyListFilters,
  type SecurityKeyStatus,
  type UpdateSecurityKeyInput,
} from './security-key.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_NOTES_LENGTH = 4096;
const CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(
  raw: string,
  field: string,
  label: string,
): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseSecurityKeyIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Security key id');
}

export function normalizeKeyCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidKeyCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    CODE_PATTERN.test(code)
  );
}

export function parseCreateSecurityKeyBody(
  body: unknown,
): Omit<CreateSecurityKeyInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const securityPostId = readOptionalNullableUuid(
    body.securityPostId,
    'securityPostId',
    details,
  );
  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );
  const status = readStatus(body.status, details);

  if (!buildingId || !code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId: buildingId as string,
    code,
    name,
    ...(description === undefined ? {} : { description }),
    ...(securityPostId === undefined ? {} : { securityPostId }),
    ...(functionalLocationId === undefined
      ? {}
      : { functionalLocationId }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateSecurityKeyBody(
  body: unknown,
): UpdateSecurityKeyInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdateSecurityKeyInput = {};

  const name = body.name === undefined ? undefined : readName(body.name, details);
  if (name !== undefined) {
    input.name = name;
  }

  const description = readOptionalText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  if (description !== undefined) {
    input.description = description;
  }

  const securityPostId = readOptionalNullableUuid(
    body.securityPostId,
    'securityPostId',
    details,
  );
  if (securityPostId !== undefined) {
    input.securityPostId = securityPostId;
  }

  const functionalLocationId = readOptionalNullableUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );
  if (functionalLocationId !== undefined) {
    input.functionalLocationId = functionalLocationId;
  }

  const status = readStatus(body.status, details);
  if (status !== undefined) {
    input.status = status;
  }

  if (Object.keys(input).length === 0) {
    details.push({
      field: 'body',
      message: 'At least one updatable field is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return input;
}

export function parseSecurityKeyListQuery(
  query: Record<string, unknown>,
): SecurityKeyListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const securityPostId = readOptionalUuid(
    query.securityPostId,
    'securityPostId',
    details,
  );
  const status = readStatus(query.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(securityPostId === undefined ? {} : { securityPostId }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseIssueSecurityKeyBody(
  body: unknown,
  keyId: string,
): Omit<IssueKeyInput, 'keyId' | 'issuedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const issuedToWorkforceId = readRequiredUuid(
    body.issuedToWorkforceId,
    'issuedToWorkforceId',
    details,
  );
  const expectedReturnAt = readOptionalDate(
    body.expectedReturnAt,
    'expectedReturnAt',
    details,
  );
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!issuedToWorkforceId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  void keyId;
  return {
    issuedToWorkforceId: issuedToWorkforceId as string,
    ...(expectedReturnAt === undefined ? {} : { expectedReturnAt }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseReturnSecurityKeyBody(
  body: unknown,
  keyId: string,
): Omit<ReturnKeyInput, 'keyId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const returnedToUserId = readRequiredUuid(
    body.returnedToUserId,
    'returnedToUserId',
    details,
  );
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!returnedToUserId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  void keyId;
  return {
    returnedToUserId: returnedToUserId as string,
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseMarkKeyLostBody(
  body: unknown,
): { notes: string | null } {
  if (body === undefined || body === null) {
    return { notes: null };
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return notes === undefined ? { notes: null } : { notes };
}

function readSingleParam(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return undefined;
  }
  return String(value);
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalNullableUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  const raw = readSingleParam(value);
  if (raw === undefined || raw === '') {
    details.push({ field: 'code', message: 'code is required.' });
    return undefined;
  }
  const normalized = normalizeKeyCode(raw);
  if (!isValidKeyCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
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
    details.push({ field: 'name', message: 'name is required.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'name is required.' });
    return undefined;
  }
  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  return parsed.toISOString();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): SecurityKeyStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isSecurityKeyStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${SECURITY_KEY_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

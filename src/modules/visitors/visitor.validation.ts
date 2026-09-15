import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VISITOR_IDENTITY_TYPES,
  VISITOR_STATUSES,
  isVisitorIdentityType,
  isVisitorStatus,
  type CreateVisitorInput,
  type UpdateVisitorInput,
  type VisitorIdentityType,
  type VisitorListFilters,
  type VisitorStatus,
} from './visitor.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_NAME_LENGTH = 256;
const MAX_IDENTITY_NUMBER_LENGTH = 128;
const MAX_PHONE_LENGTH = 32;
const MAX_EMAIL_LENGTH = 254;
const MAX_ORGANIZATION_LENGTH = 256;
const MAX_NOTES_LENGTH = 4096;
const MAX_SEARCH_LENGTH = 256;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9\s().-]{4,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVisitorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Visitor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseVisitorClientIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'Client id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVisitorBody(
  body: unknown,
): Omit<CreateVisitorInput, 'clientId' | 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const fullName = readRequiredText(
    body.fullName,
    'fullName',
    MAX_NAME_LENGTH,
    details,
  );
  const identityType = readIdentityType(body.identityType, details);
  const identityNumber = readOptionalText(
    body.identityNumber,
    'identityNumber',
    MAX_IDENTITY_NUMBER_LENGTH,
    details,
  );
  const phone = readOptionalPhone(body.phone, details);
  const email = readOptionalEmail(body.email, details);
  const organizationName = readOptionalText(
    body.organizationName,
    'organizationName',
    MAX_ORGANIZATION_LENGTH,
    details,
  );
  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  if (!fullName || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    fullName,
    ...(identityType === undefined ? {} : { identityType }),
    ...(identityNumber === undefined ? {} : { identityNumber }),
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined ? {} : { email }),
    ...(organizationName === undefined ? {} : { organizationName }),
    ...(notes === undefined ? {} : { notes }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVisitorBody(body: unknown): UpdateVisitorInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdateVisitorInput = {};

  if (body.fullName !== undefined) {
    const fullName = readRequiredText(
      body.fullName,
      'fullName',
      MAX_NAME_LENGTH,
      details,
    );
    if (fullName) {
      input.fullName = fullName;
    }
  }

  const identityType = readIdentityType(body.identityType, details);
  if (identityType !== undefined) {
    input.identityType = identityType;
  }

  const identityNumber = readOptionalText(
    body.identityNumber,
    'identityNumber',
    MAX_IDENTITY_NUMBER_LENGTH,
    details,
  );
  if (identityNumber !== undefined) {
    input.identityNumber = identityNumber;
  }

  const phone = readOptionalPhone(body.phone, details);
  if (phone !== undefined) {
    input.phone = phone;
  }

  const email = readOptionalEmail(body.email, details);
  if (email !== undefined) {
    input.email = email;
  }

  const organizationName = readOptionalText(
    body.organizationName,
    'organizationName',
    MAX_ORGANIZATION_LENGTH,
    details,
  );
  if (organizationName !== undefined) {
    input.organizationName = organizationName;
  }

  const notes = readOptionalText(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );
  if (notes !== undefined) {
    input.notes = notes;
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

export function parseVisitorListQuery(
  query: Record<string, unknown>,
): VisitorListFilters {
  const details: ValidationDetail[] = [];

  const search = readOptionalQueryText(
    query.search,
    'search',
    MAX_SEARCH_LENGTH,
    details,
  );
  const identityType = readIdentityType(
    readSingleParam(query.identityType),
    details,
  );
  const identityNumber = readOptionalQueryText(
    query.identityNumber,
    'identityNumber',
    MAX_IDENTITY_NUMBER_LENGTH,
    details,
  );
  const phone = readOptionalQueryText(
    query.phone,
    'phone',
    MAX_PHONE_LENGTH,
    details,
  );
  const email = readOptionalQueryText(
    query.email,
    'email',
    MAX_EMAIL_LENGTH,
    details,
  );
  const status = readStatus(readSingleParam(query.status), details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(search === undefined ? {} : { search }),
    ...(identityType === undefined ? {} : { identityType }),
    ...(identityNumber === undefined ? {} : { identityNumber }),
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined ? {} : { email }),
    ...(status === undefined ? {} : { status }),
  };
}

/* ------------------------------------------------------------------ */
/*  Field readers                                                      */
/* ------------------------------------------------------------------ */

function readSingleParam(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readRequiredText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
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

function readOptionalQueryText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  const single = readSingleParam(value);
  if (single === undefined || single === null || single === '') {
    return undefined;
  }
  if (typeof single !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = single.trim();
  if (trimmed === '') {
    return undefined;
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

function readOptionalPhone(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  const parsed = readOptionalText(value, 'phone', MAX_PHONE_LENGTH, details);
  if (parsed === undefined || parsed === null) {
    return parsed;
  }
  if (!PHONE_PATTERN.test(parsed)) {
    details.push({
      field: 'phone',
      message: 'phone must be a valid phone number.',
    });
    return undefined;
  }
  return parsed;
}

function readOptionalEmail(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  const parsed = readOptionalText(value, 'email', MAX_EMAIL_LENGTH, details);
  if (parsed === undefined || parsed === null) {
    return parsed;
  }
  const normalized = parsed.toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    details.push({
      field: 'email',
      message: 'email must be a valid email address.',
    });
    return undefined;
  }
  return normalized;
}

function readIdentityType(
  value: unknown,
  details: ValidationDetail[],
): VisitorIdentityType | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isVisitorIdentityType(value)) {
    details.push({
      field: 'identityType',
      message: `identityType must be one of: ${VISITOR_IDENTITY_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VisitorStatus | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isVisitorStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${VISITOR_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isWorkRequestStatus,
  WORK_REQUEST_STATUSES,
  type CreateWorkRequestInput,
  type UpdateWorkRequestInput,
  type WorkRequestFilters,
  type WorkRequestStatus,
} from './work-request.types';

const REQUEST_NUMBER_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const REQUEST_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_REQUEST_NUMBER_LENGTH = 64;
const MAX_REQUEST_TYPE_LENGTH = 64;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeRequestNumber(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidRequestNumber(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= MAX_REQUEST_NUMBER_LENGTH &&
    REQUEST_NUMBER_PATTERN.test(value)
  );
}

export function normalizeRequestType(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidRequestType(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= MAX_REQUEST_TYPE_LENGTH &&
    REQUEST_TYPE_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkRequestIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'workRequestId',
        message: 'Work request id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseWorkRequestBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

/**
 * Parses list filters for `GET /buildings/:buildingId/work-requests`.
 * `?status=` filters by exact status; `?requestType=` filters by the
 * data-driven request type code.
 */
export function parseWorkRequestFilters(query: unknown): WorkRequestFilters {
  if (!isRecord(query)) {
    return {};
  }

  const details: ValidationDetail[] = [];
  const status = readStatus(query.status, details);
  const requestType =
    query.requestType === undefined
      ? undefined
      : readRequestType(query.requestType, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(requestType === undefined ? {} : { requestType }),
  };
}

export function parseCreateWorkRequestBody(
  body: unknown,
): Omit<CreateWorkRequestInput, 'buildingId' | 'requestedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const clientId = readClientId(body.clientId, details);
  const requestNumber = readRequestNumber(body.requestNumber, details);
  const title = readTitle(body.title, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const requestType = readRequestType(body.requestType, details);

  if (!clientId || !requestNumber || !title || !requestType || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    clientId,
    requestNumber,
    title,
    ...(description === undefined ? {} : { description }),
    requestType,
  };
}

export function parseUpdateWorkRequestBody(
  body: unknown,
): UpdateWorkRequestInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const title =
    body.title === undefined ? undefined : readTitle(body.title, details);
  const description =
    body.description === undefined
      ? undefined
      : readNullableOptionalString(
          body.description,
          'description',
          MAX_DESCRIPTION_LENGTH,
          details,
        );
  const requestType =
    body.requestType === undefined
      ? undefined
      : readRequestType(body.requestType, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(requestType === undefined ? {} : { requestType }),
  };
}

function readClientId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'clientId',
      message: 'clientId is required and must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readRequestNumber(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'requestNumber',
      message: 'Work request number is required.',
    });
    return undefined;
  }

  const normalized = normalizeRequestNumber(value);
  if (!isValidRequestNumber(normalized)) {
    details.push({
      field: 'requestNumber',
      message:
        'Work request number must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readTitle(value: unknown, details: ValidationDetail[]): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'title',
      message: 'Work request title is required.',
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({
      field: 'title',
      message: 'Work request title is required.',
    });
    return undefined;
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    details.push({
      field: 'title',
      message: `Work request title must be at most ${MAX_TITLE_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readRequestType(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'requestType',
      message: 'Request type is required.',
    });
    return undefined;
  }

  const normalized = normalizeRequestType(value);
  if (!isValidRequestType(normalized)) {
    details.push({
      field: 'requestType',
      message:
        'Request type must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): WorkRequestStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isWorkRequestStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${WORK_REQUEST_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
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

/** Update-body optional string that can be explicitly cleared with null. */
function readNullableOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) {
    return null;
  }
  return readOptionalString(value, field, maxLength, details);
}

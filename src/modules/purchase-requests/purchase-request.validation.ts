import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isPurchaseRequestPriority,
  isPurchaseRequestStatus,
  PURCHASE_REQUEST_PRIORITIES,
  PURCHASE_REQUEST_STATUSES,
  type CreatePurchaseRequestInput,
  type PurchaseRequestFilters,
  type PurchaseRequestPriority,
  type PurchaseRequestStatus,
  type UpdatePurchaseRequestInput,
} from './purchase-request.types';

const REQUEST_NUMBER_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const REQUEST_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_REQUEST_NUMBER_LENGTH = 64;
const MAX_REQUEST_TYPE_LENGTH = 64;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_REQUESTER_REFERENCE_LENGTH = 200;

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

function isValidIsoDate(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function parsePurchaseRequestIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'purchaseRequestId',
        message: 'Purchase request id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parsePurchaseRequestBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

/**
 * Parses list filters for `GET /buildings/:buildingId/purchase-requests`.
 * `?status=`, `?requestType=`, `?requesterUserId=`, and `?priority=` filter by
 * exact values.
 */
export function parsePurchaseRequestFilters(
  query: unknown,
): PurchaseRequestFilters {
  if (!isRecord(query)) {
    return {};
  }

  const details: ValidationDetail[] = [];
  const status = readStatus(query.status, details);
  const requestType =
    query.requestType === undefined
      ? undefined
      : readRequestType(query.requestType, details);
  const requesterUserId =
    query.requesterUserId === undefined
      ? undefined
      : readRequesterUserId(query.requesterUserId, details);
  const priority =
    query.priority === undefined
      ? undefined
      : readPriority(query.priority, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status === undefined ? {} : { status }),
    ...(requestType === undefined ? {} : { requestType }),
    ...(requesterUserId === undefined ? {} : { requesterUserId }),
    ...(priority === undefined ? {} : { priority }),
  };
}

export function parseCreatePurchaseRequestBody(
  body: unknown,
): Omit<CreatePurchaseRequestInput, 'buildingId' | 'requestedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const clientId = readClientId(body.clientId, details);
  const requestNumber = readRequestNumber(body.requestNumber, details);
  const requesterReference = readOptionalString(
    body.requesterReference,
    'requesterReference',
    MAX_REQUESTER_REFERENCE_LENGTH,
    details,
  );
  const requestType = readRequestType(body.requestType, details);
  const title = readTitle(body.title, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const requiredDate = readRequiredDate(body.requiredDate, details);
  const priority = readPriority(body.priority, details) ?? 'MEDIUM';

  if (
    !clientId ||
    !requestNumber ||
    !requestType ||
    !title ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    clientId,
    requestNumber,
    ...(requesterReference === undefined ? {} : { requesterReference }),
    requestType,
    title,
    ...(description === undefined ? {} : { description }),
    ...(requiredDate === undefined ? {} : { requiredDate }),
    priority,
  };
}

export function parseUpdatePurchaseRequestBody(
  body: unknown,
): UpdatePurchaseRequestInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const requesterReference =
    body.requesterReference === undefined
      ? undefined
      : readNullableOptionalString(
          body.requesterReference,
          'requesterReference',
          MAX_REQUESTER_REFERENCE_LENGTH,
          details,
        );
  const requestType =
    body.requestType === undefined
      ? undefined
      : readRequestType(body.requestType, details);
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
  const requiredDate =
    body.requiredDate === undefined
      ? undefined
      : readRequiredDate(body.requiredDate, details);
  const priority =
    body.priority === undefined ? undefined : readPriority(body.priority, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(requesterReference === undefined ? {} : { requesterReference }),
    ...(requestType === undefined ? {} : { requestType }),
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(requiredDate === undefined ? {} : { requiredDate }),
    ...(priority === undefined ? {} : { priority }),
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
      message: 'Purchase request number is required.',
    });
    return undefined;
  }

  const normalized = normalizeRequestNumber(value);
  if (!isValidRequestNumber(normalized)) {
    details.push({
      field: 'requestNumber',
      message:
        'Purchase request number must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
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

function readTitle(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'title',
      message: 'Purchase request title is required.',
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({
      field: 'title',
      message: 'Purchase request title is required.',
    });
    return undefined;
  }

  if (trimmed.length > MAX_TITLE_LENGTH) {
    details.push({
      field: 'title',
      message: `Purchase request title must be at most ${MAX_TITLE_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): PurchaseRequestStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPurchaseRequestStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${PURCHASE_REQUEST_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readPriority(
  value: unknown,
  details: ValidationDetail[],
): PurchaseRequestPriority | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPurchaseRequestPriority(value)) {
    details.push({
      field: 'priority',
      message: `Priority must be one of: ${PURCHASE_REQUEST_PRIORITIES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readRequesterUserId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'requesterUserId',
      message: 'requesterUserId must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

/**
 * Reads an optional/required-date value for create. Returns a validated ISO
 * date string, or `null` when explicitly cleared, or `undefined` when absent.
 */
function readRequiredDate(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !isValidIsoDate(value)) {
    details.push({
      field: 'requiredDate',
      message: 'requiredDate must be a valid ISO date string or null.',
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

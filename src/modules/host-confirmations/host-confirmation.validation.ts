import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HOST_CONFIRMATION_STATUSES,
  isHostConfirmationStatus,
  type ConfirmHostConfirmationInput,
  type CreateHostConfirmationInput,
  type HostConfirmationListFilters,
  type HostConfirmationStatus,
  type RejectHostConfirmationInput,
} from './host-confirmation.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_HOST_NAME_LENGTH = 256;
const MAX_REASON_LENGTH = 1024;
const MAX_NOTES_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHostConfirmationIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Host confirmation id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateHostConfirmationBody(
  body: unknown,
): Omit<CreateHostConfirmationInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const expectedVisitorId = readOptionalBodyUuid(
    body.expectedVisitorId,
    'expectedVisitorId',
    details,
  );
  const walkInVisitId = readOptionalBodyUuid(
    body.walkInVisitId,
    'walkInVisitId',
    details,
  );
  const hostUserId = readOptionalNullableUuid(
    body.hostUserId,
    'hostUserId',
    details,
  );
  const hostWorkforceId = readOptionalNullableUuid(
    body.hostWorkforceId,
    'hostWorkforceId',
    details,
  );
  const hostName = readOptionalText(
    body.hostName,
    'hostName',
    MAX_HOST_NAME_LENGTH,
    details,
  );
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(expectedVisitorId === undefined ? {} : { expectedVisitorId }),
    ...(walkInVisitId === undefined ? {} : { walkInVisitId }),
    ...(hostUserId === undefined ? {} : { hostUserId }),
    ...(hostWorkforceId === undefined ? {} : { hostWorkforceId }),
    ...(hostName === undefined ? {} : { hostName }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseConfirmHostConfirmationBody(
  body: unknown,
): ConfirmHostConfirmationInput {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseRejectHostConfirmationBody(
  body: unknown,
): RejectHostConfirmationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const rejectionReason = readRequiredText(
    body.rejectionReason,
    'rejectionReason',
    MAX_REASON_LENGTH,
    details,
  );
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (!rejectionReason || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    rejectionReason,
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseHostConfirmationListQuery(
  query: Record<string, unknown>,
): HostConfirmationListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const expectedVisitorId = readOptionalUuid(
    query.expectedVisitorId,
    'expectedVisitorId',
    details,
  );
  const walkInVisitId = readOptionalUuid(
    query.walkInVisitId,
    'walkInVisitId',
    details,
  );
  const hostUserId = readOptionalUuid(query.hostUserId, 'hostUserId', details);
  const status = readStatus(readSingleParam(query.status), details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(expectedVisitorId === undefined ? {} : { expectedVisitorId }),
    ...(walkInVisitId === undefined ? {} : { walkInVisitId }),
    ...(hostUserId === undefined ? {} : { hostUserId }),
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

function readOptionalBodyUuid(
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

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const single = readSingleParam(value);
  if (single === undefined || single === null || single === '') {
    return undefined;
  }
  if (typeof single !== 'string' || !isValidUuid(single.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return single.trim().toLowerCase();
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): HostConfirmationStatus | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isHostConfirmationStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${HOST_CONFIRMATION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

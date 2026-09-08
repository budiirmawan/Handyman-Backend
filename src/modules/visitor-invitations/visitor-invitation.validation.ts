import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VISITOR_INVITATION_STATUSES,
  isVisitorInvitationStatus,
  type CreateVisitorInvitationInput,
  type UpdateVisitorInvitationInput,
  type VisitorInvitationListFilters,
  type VisitorInvitationStatus,
} from './visitor-invitation.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_HOST_NAME_LENGTH = 256;
const MAX_PURPOSE_LENGTH = 512;
const MAX_NOTES_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVisitorInvitationIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Visitor invitation id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVisitorInvitationBody(
  body: unknown,
): Omit<CreateVisitorInvitationInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const visitorId = readRequiredUuid(body.visitorId, 'visitorId', details);
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
  const expectedArrivalAt = readRequiredDate(
    body.expectedArrivalAt,
    'expectedArrivalAt',
    details,
  );
  const expectedDepartureAt = readOptionalDate(
    body.expectedDepartureAt,
    'expectedDepartureAt',
    details,
  );
  const purpose = readRequiredText(
    body.purpose,
    'purpose',
    MAX_PURPOSE_LENGTH,
    details,
  );
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (
    !buildingId ||
    !visitorId ||
    !expectedArrivalAt ||
    !purpose ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    visitorId,
    ...(hostUserId === undefined ? {} : { hostUserId }),
    ...(hostWorkforceId === undefined ? {} : { hostWorkforceId }),
    ...(hostName === undefined ? {} : { hostName }),
    expectedArrivalAt,
    ...(expectedDepartureAt === undefined ? {} : { expectedDepartureAt }),
    purpose,
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateVisitorInvitationBody(
  body: unknown,
): UpdateVisitorInvitationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdateVisitorInvitationInput = {};

  const hostUserId = readOptionalNullableUuid(
    body.hostUserId,
    'hostUserId',
    details,
  );
  if (hostUserId !== undefined) {
    input.hostUserId = hostUserId;
  }

  const hostWorkforceId = readOptionalNullableUuid(
    body.hostWorkforceId,
    'hostWorkforceId',
    details,
  );
  if (hostWorkforceId !== undefined) {
    input.hostWorkforceId = hostWorkforceId;
  }

  const hostName = readOptionalText(
    body.hostName,
    'hostName',
    MAX_HOST_NAME_LENGTH,
    details,
  );
  if (hostName !== undefined) {
    input.hostName = hostName;
  }

  if (body.expectedArrivalAt !== undefined) {
    const expectedArrivalAt = readRequiredDate(
      body.expectedArrivalAt,
      'expectedArrivalAt',
      details,
    );
    if (expectedArrivalAt) {
      input.expectedArrivalAt = expectedArrivalAt;
    }
  }

  const expectedDepartureAt = readOptionalDate(
    body.expectedDepartureAt,
    'expectedDepartureAt',
    details,
  );
  if (expectedDepartureAt !== undefined) {
    input.expectedDepartureAt = expectedDepartureAt;
  }

  if (body.purpose !== undefined) {
    const purpose = readRequiredText(
      body.purpose,
      'purpose',
      MAX_PURPOSE_LENGTH,
      details,
    );
    if (purpose) {
      input.purpose = purpose;
    }
  }

  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  if (notes !== undefined) {
    input.notes = notes;
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

export function parseVisitorInvitationListQuery(
  query: Record<string, unknown>,
): VisitorInvitationListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const visitorId = readOptionalUuid(query.visitorId, 'visitorId', details);
  const hostUserId = readOptionalUuid(query.hostUserId, 'hostUserId', details);
  const status = readStatus(readSingleParam(query.status), details);
  const expectedFrom = readOptionalQueryDate(
    query.expectedFrom,
    'expectedFrom',
    details,
  );
  const expectedTo = readOptionalQueryDate(
    query.expectedTo,
    'expectedTo',
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(visitorId === undefined ? {} : { visitorId }),
    ...(hostUserId === undefined ? {} : { hostUserId }),
    ...(status === undefined ? {} : { status }),
    ...(expectedFrom === undefined ? {} : { expectedFrom }),
    ...(expectedTo === undefined ? {} : { expectedTo }),
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

function readRequiredDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
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

function readOptionalQueryDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  const single = readSingleParam(value);
  if (single === undefined || single === null || single === '') {
    return undefined;
  }
  if (typeof single !== 'string') {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  const parsed = new Date(single);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  return parsed.toISOString();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VisitorInvitationStatus | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isVisitorInvitationStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${VISITOR_INVITATION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

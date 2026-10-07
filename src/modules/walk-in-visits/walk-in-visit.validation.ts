import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VISITOR_IDENTITY_TYPES,
  isVisitorIdentityType,
} from '../visitors';
import {
  WALK_IN_VISIT_STATUSES,
  isWalkInVisitStatus,
  type CreateWalkInVisitInput,
  type UpdateWalkInVisitInput,
  type WalkInNewVisitorInput,
  type WalkInVisitListFilters,
  type WalkInVisitStatus,
} from './walk-in-visit.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_HOST_NAME_LENGTH = 256;
const MAX_PURPOSE_LENGTH = 512;
const MAX_NOTES_LENGTH = 4096;
const MAX_NAME_LENGTH = 256;
const MAX_IDENTITY_NUMBER_LENGTH = 128;
const MAX_PHONE_LENGTH = 32;
const MAX_EMAIL_LENGTH = 254;
const MAX_ORGANIZATION_LENGTH = 256;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9\s().-]{4,31}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWalkInVisitIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Walk-in visit id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateWalkInVisitBody(
  body: unknown,
): Omit<CreateWalkInVisitInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const visitorId = readOptionalBodyUuid(body.visitorId, 'visitorId', details);
  const newVisitor = readNewVisitor(body.newVisitor, details);
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
  const purpose = readRequiredText(
    body.purpose,
    'purpose',
    MAX_PURPOSE_LENGTH,
    details,
  );
  const arrivedAt = readOptionalBodyDate(body.arrivedAt, 'arrivedAt', details);
  const frontDeskNotes = readOptionalText(
    body.frontDeskNotes,
    'frontDeskNotes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!buildingId || !purpose || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    ...(visitorId === undefined ? {} : { visitorId }),
    ...(newVisitor === undefined ? {} : { newVisitor }),
    ...(hostUserId === undefined ? {} : { hostUserId }),
    ...(hostWorkforceId === undefined ? {} : { hostWorkforceId }),
    ...(hostName === undefined ? {} : { hostName }),
    purpose,
    ...(arrivedAt === undefined ? {} : { arrivedAt }),
    ...(frontDeskNotes === undefined ? {} : { frontDeskNotes }),
  };
}

export function parseUpdateWalkInVisitBody(
  body: unknown,
): UpdateWalkInVisitInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdateWalkInVisitInput = {};

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

  if (body.arrivedAt !== undefined) {
    const arrivedAt = readOptionalBodyDate(body.arrivedAt, 'arrivedAt', details);
    if (arrivedAt) {
      input.arrivedAt = arrivedAt;
    } else if (body.arrivedAt === null) {
      details.push({
        field: 'arrivedAt',
        message: 'arrivedAt cannot be null.',
      });
    }
  }

  const frontDeskNotes = readOptionalText(
    body.frontDeskNotes,
    'frontDeskNotes',
    MAX_NOTES_LENGTH,
    details,
  );
  if (frontDeskNotes !== undefined) {
    input.frontDeskNotes = frontDeskNotes;
  }

  if (Object.keys(input).length === 0 && details.length === 0) {
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

export function parseWalkInVisitListQuery(
  query: Record<string, unknown>,
): WalkInVisitListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const visitorId = readOptionalUuid(query.visitorId, 'visitorId', details);
  const hostUserId = readOptionalUuid(query.hostUserId, 'hostUserId', details);
  const status = readStatus(readSingleParam(query.status), details);
  const arrivedFrom = readOptionalQueryDate(
    query.arrivedFrom,
    'arrivedFrom',
    details,
  );
  const arrivedTo = readOptionalQueryDate(query.arrivedTo, 'arrivedTo', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(visitorId === undefined ? {} : { visitorId }),
    ...(hostUserId === undefined ? {} : { hostUserId }),
    ...(status === undefined ? {} : { status }),
    ...(arrivedFrom === undefined ? {} : { arrivedFrom }),
    ...(arrivedTo === undefined ? {} : { arrivedTo }),
  };
}

/* ------------------------------------------------------------------ */
/*  Inline new-visitor payload                                         */
/* ------------------------------------------------------------------ */

function readNewVisitor(
  value: unknown,
  details: ValidationDetail[],
): WalkInNewVisitorInput | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value)) {
    details.push({
      field: 'newVisitor',
      message: 'newVisitor must be a JSON object.',
    });
    return undefined;
  }

  const fullName = readRequiredText(
    value.fullName,
    'newVisitor.fullName',
    MAX_NAME_LENGTH,
    details,
  );
  const identityType = readIdentityType(value.identityType, details);
  const identityNumber = readOptionalText(
    value.identityNumber,
    'newVisitor.identityNumber',
    MAX_IDENTITY_NUMBER_LENGTH,
    details,
  );
  const phone = readOptionalPhone(value.phone, details);
  const email = readOptionalEmail(value.email, details);
  const organizationName = readOptionalText(
    value.organizationName,
    'newVisitor.organizationName',
    MAX_ORGANIZATION_LENGTH,
    details,
  );
  const notes = readOptionalText(
    value.notes,
    'newVisitor.notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!fullName) {
    return undefined;
  }

  return {
    fullName,
    ...(identityType === undefined ? {} : { identityType }),
    ...(identityNumber === undefined ? {} : { identityNumber }),
    ...(phone === undefined ? {} : { phone }),
    ...(email === undefined ? {} : { email }),
    ...(organizationName === undefined ? {} : { organizationName }),
    ...(notes === undefined ? {} : { notes }),
  };
}

function readIdentityType(value: unknown, details: ValidationDetail[]) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isVisitorIdentityType(value)) {
    details.push({
      field: 'newVisitor.identityType',
      message: `identityType must be one of: ${VISITOR_IDENTITY_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readOptionalPhone(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  const parsed = readOptionalText(
    value,
    'newVisitor.phone',
    MAX_PHONE_LENGTH,
    details,
  );
  if (parsed === undefined || parsed === null) {
    return parsed;
  }
  if (!PHONE_PATTERN.test(parsed)) {
    details.push({
      field: 'newVisitor.phone',
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
  const parsed = readOptionalText(
    value,
    'newVisitor.email',
    MAX_EMAIL_LENGTH,
    details,
  );
  if (parsed === undefined || parsed === null) {
    return parsed;
  }
  const normalized = parsed.toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) {
    details.push({
      field: 'newVisitor.email',
      message: 'email must be a valid email address.',
    });
    return undefined;
  }
  return normalized;
}

/* ------------------------------------------------------------------ */
/*  Generic field readers                                              */
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

function readOptionalBodyDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
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
): WalkInVisitStatus | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isWalkInVisitStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${WALK_IN_VISIT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

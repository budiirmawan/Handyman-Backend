import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VISIT_CHECK_IN_STATUSES,
  isVisitCheckInStatus,
  type CheckOutVisitInput,
  type CreateVisitCheckInInput,
  type VisitCheckInListFilters,
  type VisitCheckInStatus,
} from './visit-check-in.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_NOTES_LENGTH = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVisitCheckInIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Visit check-in id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVisitCheckInBody(
  body: unknown,
): Omit<CreateVisitCheckInInput, 'checkedInByUserId'> {
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
  const checkedInAt = readOptionalBodyDate(
    body.checkedInAt,
    'checkedInAt',
    details,
  );
  const entryNotes = readOptionalText(
    body.entryNotes,
    'entryNotes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(expectedVisitorId === undefined ? {} : { expectedVisitorId }),
    ...(walkInVisitId === undefined ? {} : { walkInVisitId }),
    ...(checkedInAt === undefined ? {} : { checkedInAt }),
    ...(entryNotes === undefined ? {} : { entryNotes }),
  };
}

export function parseCheckOutVisitBody(
  body: unknown,
): Omit<CheckOutVisitInput, 'checkedOutByUserId'> {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const checkedOutAt = readOptionalBodyDate(
    body.checkedOutAt,
    'checkedOutAt',
    details,
  );
  const exitNotes = readOptionalText(
    body.exitNotes,
    'exitNotes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(checkedOutAt === undefined ? {} : { checkedOutAt }),
    ...(exitNotes === undefined ? {} : { exitNotes }),
  };
}

export function parseVisitCheckInListQuery(
  query: Record<string, unknown>,
): VisitCheckInListFilters {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const visitorId = readOptionalUuid(query.visitorId, 'visitorId', details);
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
  const status = readStatus(readSingleParam(query.status), details);
  const checkedInFrom = readOptionalQueryDate(
    query.checkedInFrom,
    'checkedInFrom',
    details,
  );
  const checkedInTo = readOptionalQueryDate(
    query.checkedInTo,
    'checkedInTo',
    details,
  );
  const checkedOutFrom = readOptionalQueryDate(
    query.checkedOutFrom,
    'checkedOutFrom',
    details,
  );
  const checkedOutTo = readOptionalQueryDate(
    query.checkedOutTo,
    'checkedOutTo',
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(visitorId === undefined ? {} : { visitorId }),
    ...(expectedVisitorId === undefined ? {} : { expectedVisitorId }),
    ...(walkInVisitId === undefined ? {} : { walkInVisitId }),
    ...(status === undefined ? {} : { status }),
    ...(checkedInFrom === undefined ? {} : { checkedInFrom }),
    ...(checkedInTo === undefined ? {} : { checkedInTo }),
    ...(checkedOutFrom === undefined ? {} : { checkedOutFrom }),
    ...(checkedOutTo === undefined ? {} : { checkedOutTo }),
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
): VisitCheckInStatus | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isVisitCheckInStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${VISIT_CHECK_IN_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

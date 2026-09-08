import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VISITOR_PASS_STATUSES,
  isVisitorPassStatus,
  type IssueVisitorPassInput,
  type ReturnVisitorPassInput,
  type VisitorPassListFilters,
  type VisitorPassStatus,
} from './visitor-pass.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_PASS_CODE_LENGTH = 64;
const PASS_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeVisitorPassCode(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidVisitorPassCode(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= MAX_PASS_CODE_LENGTH &&
    PASS_CODE_PATTERN.test(value)
  );
}

export function parseVisitorPassIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Visitor pass id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseIssueVisitorPassBody(
  body: unknown,
): Omit<IssueVisitorPassInput, 'issuedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const visitCheckInId = readRequiredUuid(
    body.visitCheckInId,
    'visitCheckInId',
    details,
  );
  const passCode = readPassCode(body.passCode, details);
  const issuedAt = readOptionalDate(body.issuedAt, 'issuedAt', details);

  if (!buildingId || !visitCheckInId || !passCode || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    visitCheckInId,
    passCode,
    ...(issuedAt === undefined ? {} : { issuedAt }),
  };
}

export function parseReturnVisitorPassBody(
  body: unknown,
): Omit<ReturnVisitorPassInput, 'returnedByUserId'> {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const returnedAt = readOptionalDate(
    body.returnedAt,
    'returnedAt',
    details,
  );
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return returnedAt === undefined ? {} : { returnedAt };
}

export function parseVisitorPassListQuery(
  query: Record<string, unknown>,
): VisitorPassListFilters {
  const details: ValidationDetail[] = [];
  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);
  const visitCheckInId = readOptionalUuid(
    query.visitCheckInId,
    'visitCheckInId',
    details,
  );
  const status = readStatus(readSingleParam(query.status), details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(visitCheckInId === undefined ? {} : { visitCheckInId }),
    ...(status === undefined ? {} : { status }),
  };
}

function readSingleParam(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
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

function readPassCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'passCode', message: 'passCode is required.' });
    return undefined;
  }
  const normalized = normalizeVisitorPassCode(value);
  if (!isValidVisitorPassCode(normalized)) {
    details.push({
      field: 'passCode',
      message:
        'passCode must contain only letters, digits, hyphens, or underscores (1-64 characters).',
    });
    return undefined;
  }
  return normalized;
}

function readOptionalDate(
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VisitorPassStatus | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (!isVisitorPassStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${VISITOR_PASS_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  FINDING_STATUSES,
  isFindingStatus,
  type CreateFindingInput,
  type FindingFilters,
  type FindingStatus,
  type UpdateFindingInput,
} from './finding.types';

const FINDING_NUMBER_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_FINDING_NUMBER_LENGTH = 64;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2000;

export type ValidationDetail = { field: string; message: string };

export function normalizeFindingNumber(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidFindingNumber(value: string): boolean {
  return value.length >= 2 && value.length <= MAX_FINDING_NUMBER_LENGTH &&
    FINDING_NUMBER_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validation(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseFindingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    validation([{ field: 'findingId', message: 'Finding id must be a valid UUID.' }]);
  }
  return value.toLowerCase();
}

export function parseFindingBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    validation([{ field: 'buildingId', message: 'Building id must be a valid UUID.' }]);
  }
  return value.toLowerCase();
}

export function parseFindingFilters(query: unknown): FindingFilters {
  if (!isRecord(query) || query.status === undefined) return {};
  if (!isFindingStatus(query.status)) {
    validation([{
      field: 'status',
      message: `Status must be one of: ${FINDING_STATUSES.join(', ')}.`,
    }]);
  }
  return { status: query.status as FindingStatus };
}

export function parseCreateFindingBody(
  body: unknown,
): Omit<CreateFindingInput, 'buildingId' | 'reportedByUserId'> {
  if (!isRecord(body)) {
    validation([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const clientId = readUuid(body.clientId, 'clientId', details);
  const findingNumber = readFindingNumber(body.findingNumber, details);
  const title = readTitle(body.title, details);
  const description = readDescription(body.description, false, details);
  if (!clientId || !findingNumber || !title || details.length > 0) validation(details);
  return {
    clientId: clientId as string,
    findingNumber: findingNumber as string,
    title: title as string,
    ...(description === undefined ? {} : { description: description as string }),
  };
}

export function parseUpdateFindingBody(body: unknown): UpdateFindingInput {
  if (!isRecord(body)) {
    validation([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const title = body.title === undefined ? undefined : readTitle(body.title, details);
  const description = body.description === undefined
    ? undefined
    : readDescription(body.description, true, details);
  const classificationId = body.classificationId === undefined
    ? undefined
    : readNullableUuid(body.classificationId, 'classificationId', details);
  const severityId = body.severityId === undefined
    ? undefined
    : readNullableUuid(body.severityId, 'severityId', details);
  if (details.length > 0) validation(details);
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(classificationId === undefined ? {} : { classificationId }),
    ...(severityId === undefined ? {} : { severityId }),
  };
}

function readUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} is required and must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readNullableUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID or null.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readFindingNumber(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'findingNumber', message: 'Finding number is required.' });
    return undefined;
  }
  const normalized = normalizeFindingNumber(value);
  if (!isValidFindingNumber(normalized)) {
    details.push({
      field: 'findingNumber',
      message: 'Finding number must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }
  return normalized;
}

function readTitle(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field: 'title', message: 'Finding title is required.' });
    return undefined;
  }
  const title = value.trim();
  if (title.length > MAX_TITLE_LENGTH) {
    details.push({ field: 'title', message: `Finding title must be at most ${MAX_TITLE_LENGTH} characters.` });
    return undefined;
  }
  return title;
}

function readDescription(
  value: unknown,
  nullable: boolean,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null && nullable) return null;
  if (value === null) return undefined;
  if (typeof value !== 'string') {
    details.push({ field: 'description', message: 'description must be a string.' });
    return undefined;
  }
  const description = value.trim();
  if (description === '') return nullable ? null : undefined;
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    details.push({ field: 'description', message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.` });
    return undefined;
  }
  return description;
}

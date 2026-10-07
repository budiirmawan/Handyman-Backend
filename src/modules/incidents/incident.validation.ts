import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  INCIDENT_LOCATION_TYPES,
  INCIDENT_PRIORITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  INCIDENT_TYPES,
  isIncidentLocationType,
  isIncidentPriority,
  isIncidentSeverity,
  isIncidentStatus,
  isIncidentType,
  type CreateIncidentInput,
  type IncidentFilters,
  type IncidentLocationType,
  type IncidentPriority,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentType,
  type UpdateIncidentInput,
} from './incident.types';

export type ValidationDetail = { field: string; message: string };

const INCIDENT_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_\-/]{0,63}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

export const parseIncidentIdParam = (raw: string): string =>
  parseId(raw, 'incidentId');

export function normalizeIncidentNumber(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidIncidentNumber(value: string): boolean {
  return INCIDENT_NUMBER_PATTERN.test(value);
}

/**
 * `clientId`, `status`, and `reportedByUserId` are refused outright rather
 * than ignored: a caller trying to set them is trying to choose its own
 * tenancy or identity, and silence would hide that.
 */
export function parseCreateIncidentBody(body: unknown): CreateIncidentInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const controlled = [
    'clientId',
    'status',
    'reportedByUserId',
    'cancelledAt',
    'cancelledByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (controlled) {
    fail([
      {
        field: controlled,
        message: 'This Incident field is derived by the backend.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const incidentNumber = readIncidentNumber(body.incidentNumber, details);
  const incidentType = readIncidentType(body.incidentType, details);
  const title = readText(body.title, 'title', MAX_TITLE_LENGTH, true, details);
  const description = readNullableText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const severity = readSeverity(body.severity, details);
  const priority = readPriority(body.priority, details);
  const locationType = readLocationType(body.locationType, details);
  const locationId = readId(body.locationId, 'locationId', false, details);
  const reportedAt = readTimestamp(body.reportedAt, 'reportedAt', details);

  // Location is optional, but a half-specified location is a caller error.
  if (locationType && !locationId) {
    details.push({
      field: 'locationId',
      message: 'locationId is required when locationType is provided.',
    });
  }
  if (locationId && !locationType) {
    details.push({
      field: 'locationType',
      message: 'locationType is required when locationId is provided.',
    });
  }

  if (
    !buildingId ||
    !incidentNumber ||
    !incidentType ||
    !title ||
    details.length > 0
  ) {
    fail(details);
  }

  return {
    buildingId,
    incidentNumber,
    incidentType,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
    ...(locationType ? { locationType } : {}),
    ...(locationId ? { locationId } : {}),
    ...(reportedAt ? { reportedAt } : {}),
  };
}

export function parseUpdateIncidentBody(body: unknown): UpdateIncidentInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const immutable = [
    'clientId',
    'buildingId',
    'incidentNumber',
    'incidentType',
    'status',
    'locationType',
    'locationId',
    'floorId',
    'areaId',
    'roomId',
    'spaceId',
    'functionalLocationId',
    'reportedByUserId',
    'reportedAt',
    'cancelledAt',
    'cancelledByUserId',
    'createdAt',
    'updatedAt',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([
      { field: immutable, message: 'This Incident context field is immutable.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const title = body.title === undefined
    ? undefined
    : readText(body.title, 'title', MAX_TITLE_LENGTH, true, details);
  const description = readNullableText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const severity = readSeverity(body.severity, details);
  const priority = readPriority(body.priority, details);

  const parsed: UpdateIncidentInput = {
    ...(title ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
  };
  if (Object.keys(parsed).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one Incident metadata field is required.',
    });
  }
  if (details.length > 0) fail(details);
  return parsed;
}

export function parseIncidentFilters(query: unknown): IncidentFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const incidentType = readIncidentTypeFilter(query.incidentType, details);
  const severity = readSeverity(query.severity, details);
  const priority = readPriority(query.priority, details);
  const status = readStatus(query.status, details);
  if (details.length > 0) fail(details);

  return {
    ...(buildingId ? { buildingId } : {}),
    ...(incidentType ? { incidentType } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
    ...(status ? { status } : {}),
  };
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field}${required ? ' is required and' : ''} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readIncidentNumber(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'incidentNumber',
      message: 'incidentNumber is required.',
    });
    return undefined;
  }
  const normalized = normalizeIncidentNumber(value);
  if (!isValidIncidentNumber(normalized)) {
    details.push({
      field: 'incidentNumber',
      message: 'incidentNumber has an invalid format.',
    });
    return undefined;
  }
  return normalized;
}

function readIncidentType(
  value: unknown,
  details: ValidationDetail[],
): IncidentType | undefined {
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentType(normalized)) {
    details.push({
      field: 'incidentType',
      message: `incidentType must be one of: ${INCIDENT_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readIncidentTypeFilter(
  value: unknown,
  details: ValidationDetail[],
): IncidentType | undefined {
  if (value === undefined) return undefined;
  return readIncidentType(value, details);
}

function readSeverity(
  value: unknown,
  details: ValidationDetail[],
): IncidentSeverity | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentSeverity(normalized)) {
    details.push({
      field: 'severity',
      message: `severity must be one of: ${INCIDENT_SEVERITIES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readPriority(
  value: unknown,
  details: ValidationDetail[],
): IncidentPriority | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentPriority(normalized)) {
    details.push({
      field: 'priority',
      message: `priority must be one of: ${INCIDENT_PRIORITIES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): IncidentStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentStatus(normalized)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${INCIDENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readLocationType(
  value: unknown,
  details: ValidationDetail[],
): IncidentLocationType | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentLocationType(normalized)) {
    details.push({
      field: 'locationType',
      message: `locationType must be one of: ${INCIDENT_LOCATION_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readText(
  value: unknown,
  field: string,
  maxLength: number,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({
      field,
      message: `${field}${required ? ' is required' : ' must be a string'}.`,
    });
    return undefined;
  }
  const result = value.trim();
  if (result.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return result;
}

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readText(value, field, maxLength, false, details);
}

function readTimestamp(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_WITH_ZONE.test(value.trim())) {
    details.push({
      field,
      message: `${field} must be an ISO-8601 date-time with a timezone.`,
    });
    return undefined;
  }
  const result = new Date(value.trim());
  if (Number.isNaN(result.getTime())) {
    details.push({ field, message: `${field} must be valid.` });
    return undefined;
  }
  return result;
}

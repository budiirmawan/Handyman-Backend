import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { FINDING_STATUSES, isFindingStatus, type FindingStatus } from '../findings';
import {
  INCIDENT_PRIORITIES,
  INCIDENT_SEVERITIES,
  INCIDENT_STATUSES,
  isIncidentPriority,
  isIncidentSeverity,
  isIncidentStatus,
  type IncidentPriority,
  type IncidentSeverity,
  type IncidentStatus,
} from '../incidents';
import {
  FINDING_ESCALATION_REASONS,
  isFindingEscalationReason,
  type CreateFindingEscalationInput,
  type FindingEscalationFilters,
  type FindingEscalationReason,
  type UpdateFindingEscalationInput,
} from './finding-escalation.types';

export type ValidationDetail = { field: string; message: string };

const INCIDENT_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9_\-/]{0,63}$/;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const MAX_NOTES_LENGTH = 4000;
const ISO_TIMESTAMP_WITH_ZONE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export function parseFindingEscalationIdParam(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field: 'incidentId', message: 'incidentId must be a valid UUID.' }]);
  }
  return value;
}

/**
 * `buildingId` / `clientId` are refused rather than ignored: the escalation
 * context is derived from the Finding, and accepting them would let a caller
 * assert a context that contradicts BE-09.
 */
export function parseCreateFindingEscalationBody(
  body: unknown,
): CreateFindingEscalationInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const derived = [
    'clientId',
    'buildingId',
    'incidentType',
    'status',
    'incidentStatus',
    'cancelledAt',
    'cancelledByUserId',
    'createdAt',
    'updatedAt',
    'escalatedAt',
  ].find((field) => body[field] !== undefined);
  if (derived) {
    fail([
      {
        field: derived,
        message:
          derived === 'incidentType'
            ? 'incidentType is fixed to FINDING_ESCALATION by this endpoint.'
            : derived === 'clientId' || derived === 'buildingId'
              ? 'Escalation context is derived from the referenced Finding.'
              : 'This Incident field is derived by the backend.',
      },
    ]);
  }

  // Finding state and workflow belong to BE-09: this endpoint escalates a
  // Finding, it never mutates one. Accepting these would imply otherwise.
  const findingOwned = [
    'findingStatus',
    'findingNumber',
    'findingTitle',
    'status',
    'state',
    'closedAt',
    'closureNotes',
  ].find((field) => body[field] !== undefined);
  if (findingOwned) {
    fail([
      {
        field: findingOwned,
        message:
          'Finding state is owned by the Finding module; supply findingId only.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];
  const findingId = readId(body.findingId, 'findingId', true, details);
  const incidentNumber = readIncidentNumber(body.incidentNumber, details);
  const title = readText(body.title, 'title', MAX_TITLE_LENGTH, true, details);
  const description = readNullableText(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const severity = readSeverity(body.severity, details);
  const priority = readPriority(body.priority, details);
  const escalationReason = readReason(body.escalationReason, true, details);
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (
    !findingId ||
    !incidentNumber ||
    !title ||
    !escalationReason ||
    details.length > 0
  ) {
    fail(details);
  }

  return {
    findingId,
    incidentNumber,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
    escalationReason,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdateFindingEscalationBody(
  body: unknown,
): UpdateFindingEscalationInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }

  const immutable = [
    'clientId',
    'buildingId',
    'incidentNumber',
    'incidentType',
    'status',
    'incidentStatus',
    'reportedByUserId',
    'reportedAt',
    'cancelledAt',
    'cancelledByUserId',
    'createdAt',
    'updatedAt',
    'escalatedAt',
    // Re-pointing an escalation at another Finding would rewrite history.
    'findingId',
    'findingStatus',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([
      {
        field: immutable,
        message:
          immutable === 'findingId'
            ? 'The Finding binding is immutable; cancel and re-escalate instead.'
            : immutable === 'findingStatus'
              ? 'Finding state is owned by the Finding module.'
              : 'This Incident context field is immutable.',
      },
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
  const escalationReason = readReason(body.escalationReason, false, details);
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  const parsed: UpdateFindingEscalationInput = {
    ...(title ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
    ...(escalationReason ? { escalationReason } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
  if (Object.keys(parsed).length === 0 && details.length === 0) {
    details.push({
      field: 'body',
      message: 'At least one Finding Escalation field is required.',
    });
  }
  if (details.length > 0) fail(details);
  return parsed;
}

export function parseFindingEscalationFilters(
  query: unknown,
): FindingEscalationFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const findingId = readId(query.findingId, 'findingId', false, details);
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const escalationReason = readReason(query.escalationReason, false, details);
  const severity = readSeverity(query.severity, details);
  const priority = readPriority(query.priority, details);
  const incidentStatus = readIncidentStatus(query.incidentStatus, details);
  const findingStatus = readFindingStatus(query.findingStatus, details);
  const escalatedFrom = readTimestamp(
    query.escalatedFrom,
    'escalatedFrom',
    details,
  );
  const escalatedTo = readTimestamp(query.escalatedTo, 'escalatedTo', details);
  if (
    escalatedFrom &&
    escalatedTo &&
    escalatedFrom.getTime() > escalatedTo.getTime()
  ) {
    details.push({
      field: 'escalatedFrom',
      message: 'escalatedFrom must be earlier than or equal to escalatedTo.',
    });
  }
  if (details.length > 0) fail(details);

  return {
    ...(findingId ? { findingId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(escalationReason ? { escalationReason } : {}),
    ...(severity ? { severity } : {}),
    ...(priority ? { priority } : {}),
    ...(incidentStatus ? { incidentStatus } : {}),
    ...(findingStatus ? { findingStatus } : {}),
    ...(escalatedFrom ? { escalatedFrom } : {}),
    ...(escalatedTo ? { escalatedTo } : {}),
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
  const normalized = value.trim().toUpperCase();
  if (!INCIDENT_NUMBER_PATTERN.test(normalized)) {
    details.push({
      field: 'incidentNumber',
      message: 'incidentNumber has an invalid format.',
    });
    return undefined;
  }
  return normalized;
}

function readReason(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): FindingEscalationReason | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isFindingEscalationReason(normalized)) {
    details.push({
      field: 'escalationReason',
      message: `escalationReason must be one of: ${FINDING_ESCALATION_REASONS.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readFindingStatus(
  value: unknown,
  details: ValidationDetail[],
): FindingStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isFindingStatus(normalized)) {
    details.push({
      field: 'findingStatus',
      message: `findingStatus must be one of: ${FINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readIncidentStatus(
  value: unknown,
  details: ValidationDetail[],
): IncidentStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isIncidentStatus(normalized)) {
    details.push({
      field: 'incidentStatus',
      message: `incidentStatus must be one of: ${INCIDENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
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

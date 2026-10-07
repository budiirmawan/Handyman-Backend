import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PATROL_EXECUTION_STATUSES,
  isPatrolExecutionStatus,
  type PatrolExecutionFilter,
  type PatrolExecutionStatus,
  type PatrolPointVisitInput,
  type UpdatePatrolPointVisitInput,
} from './patrol-execution.types';

const MAX_NOTES_LENGTH = 512;
const MAX_COMPLETION_NOTES_LENGTH = 512;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePatrolExecutionIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Patrol execution id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parsePatrolExecutionBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parsePatrolExecutionPointIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'pointId',
        message: 'Patrol route point id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parsePatrolExecutionVisitIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'visitId',
        message: 'Patrol point visit id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parsePatrolExecutionFilter(
  query: Record<string, unknown>,
): PatrolExecutionFilter {
  const details: ValidationDetail[] = [];

  const date = readDate(query.date, details);
  const status =
    query.status === undefined
      ? undefined
      : readStatus(query.status, details);
  const patrolRouteId =
    query.patrolRouteId === undefined
      ? undefined
      : readOptionalUuid(query.patrolRouteId, 'patrolRouteId', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(date !== undefined ? { date } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(patrolRouteId !== undefined ? { patrolRouteId } : {}),
  };
}

export function parseVisitBody(body: unknown): PatrolPointVisitInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const patrolRoutePointId = readRequiredUuid(
    body.patrolRoutePointId,
    'patrolRoutePointId',
    details,
  );
  const notes = readOptionalString(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!patrolRoutePointId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    patrolRoutePointId,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdateVisitBody(
  body: unknown,
): UpdatePatrolPointVisitInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const notes = readOptionalString(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseCompleteBody(
  body: unknown,
): { completionNotes: string | null } {
  if (body === undefined || body === null) {
    return { completionNotes: null };
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const completionNotes = readOptionalString(
    body.completionNotes,
    'completionNotes',
    MAX_COMPLETION_NOTES_LENGTH,
    details,
  );
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { completionNotes: completionNotes ?? null };
}

function readDate(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) {
    details.push({
      field: 'date',
      message: 'Date must be a valid ISO date (YYYY-MM-DD).',
    });
    return undefined;
  }
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    details.push({ field: 'date', message: 'Date must be a real calendar day.' });
    return undefined;
  }
  return value;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): PatrolExecutionStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPatrolExecutionStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${PATROL_EXECUTION_STATUSES.join(', ')}.`,
    });
    return undefined;
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
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
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
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

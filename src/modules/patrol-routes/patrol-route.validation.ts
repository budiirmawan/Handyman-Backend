import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PATROL_ROUTE_POINT_STATUSES,
  PATROL_ROUTE_STATUSES,
  isPatrolRoutePointStatus,
  isPatrolRouteStatus,
  type CreatePatrolRouteInput,
  type CreatePatrolRoutePointInput,
  type PatrolRouteStatus,
  type UpdatePatrolRouteInput,
  type UpdatePatrolRoutePointInput,
} from './patrol-route.types';

const PATROL_ROUTE_CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_CODE_LENGTH = 64;
const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 512;
const MAX_NOTES_LENGTH = 512;
const MIN_SEQUENCE = 1;
const MAX_SEQUENCE = 100000;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizePatrolRouteCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidPatrolRouteCode(code: string): boolean {
  return (
    code.length >= 2 &&
    code.length <= MAX_CODE_LENGTH &&
    PATROL_ROUTE_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePatrolRouteIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Patrol route id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parsePatrolRoutePointIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Patrol route point id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parsePatrolRouteBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreatePatrolRouteBody(
  body: unknown,
): Omit<CreatePatrolRouteInput, 'buildingId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const code = readCode(body.code, details);
  const name = readName(body.name, details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);
  const startSecurityPostId = readOptionalUuid(
    body.startSecurityPostId,
    'startSecurityPostId',
    details,
  );

  if (!code || !name || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    code,
    name,
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(startSecurityPostId !== undefined ? { startSecurityPostId } : {}),
  };
}

export function parseUpdatePatrolRouteBody(
  body: unknown,
): UpdatePatrolRouteInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name = body.name === undefined ? undefined : readName(body.name, details);
  const description =
    body.description === undefined
      ? undefined
      : readOptionalString(
          body.description,
          'description',
          MAX_DESCRIPTION_LENGTH,
          details,
        );
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);
  const startSecurityPostId =
    body.startSecurityPostId === undefined
      ? undefined
      : readOptionalUuid(
          body.startSecurityPostId,
          'startSecurityPostId',
          details,
        );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(startSecurityPostId !== undefined ? { startSecurityPostId } : {}),
  };
}

export function parseCreatePatrolRoutePointBody(
  body: unknown,
): Omit<CreatePatrolRoutePointInput, 'patrolRouteId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const sequence = readSequence(body.sequence, details);
  const notes = readOptionalString(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );
  const status = readPointStatus(body.status, details);
  const floorId = readOptionalUuid(body.floorId, 'floorId', details);
  const areaId = readOptionalUuid(body.areaId, 'areaId', details);
  const roomId = readOptionalUuid(body.roomId, 'roomId', details);
  const spaceId = readOptionalUuid(body.spaceId, 'spaceId', details);
  const functionalLocationId = readOptionalUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );

  if (sequence === undefined || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    sequence,
    ...(notes !== undefined ? { notes } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(floorId !== undefined ? { floorId } : {}),
    ...(areaId !== undefined ? { areaId } : {}),
    ...(roomId !== undefined ? { roomId } : {}),
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(functionalLocationId !== undefined ? { functionalLocationId } : {}),
  };
}

export function parseUpdatePatrolRoutePointBody(
  body: unknown,
): UpdatePatrolRoutePointInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const sequence =
    body.sequence === undefined ? undefined : readSequence(body.sequence, details);
  const notes =
    body.notes === undefined
      ? undefined
      : readOptionalString(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  const status =
    body.status === undefined ? undefined : readPointStatus(body.status, details);
  const floorId =
    body.floorId === undefined
      ? undefined
      : readOptionalUuid(body.floorId, 'floorId', details);
  const areaId =
    body.areaId === undefined
      ? undefined
      : readOptionalUuid(body.areaId, 'areaId', details);
  const roomId =
    body.roomId === undefined
      ? undefined
      : readOptionalUuid(body.roomId, 'roomId', details);
  const spaceId =
    body.spaceId === undefined
      ? undefined
      : readOptionalUuid(body.spaceId, 'spaceId', details);
  const functionalLocationId =
    body.functionalLocationId === undefined
      ? undefined
      : readOptionalUuid(
          body.functionalLocationId,
          'functionalLocationId',
          details,
        );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(sequence !== undefined ? { sequence } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(floorId !== undefined ? { floorId } : {}),
    ...(areaId !== undefined ? { areaId } : {}),
    ...(roomId !== undefined ? { roomId } : {}),
    ...(spaceId !== undefined ? { spaceId } : {}),
    ...(functionalLocationId !== undefined ? { functionalLocationId } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Shared readers                                                     */
/* ------------------------------------------------------------------ */

function readCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'code',
      message: 'Patrol route code is required.',
    });
    return undefined;
  }

  const normalized = normalizePatrolRouteCode(value);
  if (!isValidPatrolRouteCode(normalized)) {
    details.push({
      field: 'code',
      message:
        'Patrol route code must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readName(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field: 'name', message: 'Patrol route name is required.' });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field: 'name', message: 'Patrol route name is required.' });
    return undefined;
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    details.push({
      field: 'name',
      message: `Patrol route name must be at most ${MAX_NAME_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readSequence(
  value: unknown,
  details: ValidationDetail[],
): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    details.push({
      field: 'sequence',
      message: 'Sequence must be a positive integer.',
    });
    return undefined;
  }

  if (value < MIN_SEQUENCE || value > MAX_SEQUENCE) {
    details.push({
      field: 'sequence',
      message: `Sequence must be between ${MIN_SEQUENCE} and ${MAX_SEQUENCE}.`,
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

function readOptionalUuid(
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): PatrolRouteStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPatrolRouteStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${PATROL_ROUTE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

function readPointStatus(
  value: unknown,
  details: ValidationDetail[],
):
  | (typeof PATROL_ROUTE_POINT_STATUSES)[number]
  | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPatrolRoutePointStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${PATROL_ROUTE_POINT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

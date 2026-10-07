import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PATROL_SCHEDULE_BINDING_STATUSES,
  isPatrolScheduleBindingStatus,
  type CreatePatrolScheduleBindingInput,
  type PatrolScheduleBindingFilter,
  type PatrolScheduleBindingStatus,
  type UpdatePatrolScheduleBindingInput,
} from './patrol-schedule-binding.types';

const MAX_DESCRIPTION_LENGTH = 512;
const MAX_NAME_LENGTH = 160;
const MAX_CODE_LENGTH = 64;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePatrolScheduleBindingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Patrol schedule binding id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
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

export function parseCreatePatrolScheduleBindingBody(
  body: unknown,
): Omit<CreatePatrolScheduleBindingInput, 'patrolRouteId' | 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const scheduleDefinitionId = readOptionalUuid(
    body.scheduleDefinitionId,
    'scheduleDefinitionId',
    details,
  );
  const startSecurityPostId = readOptionalUuid(
    body.startSecurityPostId,
    'startSecurityPostId',
    details,
  );
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  // Optional inline schedule creation fields
  const code = readOptionalString(body.code, 'code', MAX_CODE_LENGTH, details);
  const name = readOptionalString(body.name, 'name', MAX_NAME_LENGTH, details);
  const targetType =
    typeof body.targetType === 'string' ? body.targetType.trim() : undefined;
  const targetId = readOptionalUuid(body.targetId, 'targetId', details);
  const startAt =
    typeof body.startAt === 'string' ? body.startAt.trim() : undefined;
  const endAt =
    typeof body.endAt === 'string' ? body.endAt.trim() : undefined;
  const timezone =
    typeof body.timezone === 'string' ? body.timezone.trim() : undefined;

  if (
    !scheduleDefinitionId &&
    (!targetType || !targetId || !name || !startAt || !timezone)
  ) {
    if (!scheduleDefinitionId) {
      details.push({
        field: 'scheduleDefinitionId',
        message:
          'scheduleDefinitionId is required unless inline schedule fields (targetType, targetId, name, startAt, timezone) are provided.',
      });
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(scheduleDefinitionId !== undefined
      ? { scheduleDefinitionId: scheduleDefinitionId ?? undefined }
      : {}),
    ...(startSecurityPostId !== undefined
      ? { startSecurityPostId }
      : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code: code ?? undefined } : {}),
    ...(name !== undefined ? { name: name ?? undefined } : {}),
    ...(targetType !== undefined ? { targetType } : {}),
    ...(targetId !== undefined ? { targetId: targetId ?? undefined } : {}),
    ...(startAt !== undefined ? { startAt } : {}),
    ...(endAt !== undefined ? { endAt } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
  };
}

export function parseUpdatePatrolScheduleBindingBody(
  body: unknown,
): UpdatePatrolScheduleBindingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const startSecurityPostId =
    body.startSecurityPostId === undefined
      ? undefined
      : readOptionalUuid(
          body.startSecurityPostId,
          'startSecurityPostId',
          details,
        );
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

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(startSecurityPostId !== undefined ? { startSecurityPostId } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parsePatrolScheduleBindingFilter(
  query: Record<string, unknown>,
): PatrolScheduleBindingFilter {
  const details: ValidationDetail[] = [];

  const status =
    query.status === undefined ? undefined : readStatus(query.status, details);
  const buildingId =
    query.buildingId === undefined
      ? undefined
      : readOptionalUuid(query.buildingId, 'buildingId', details);
  const patrolRouteId =
    query.patrolRouteId === undefined
      ? undefined
      : readOptionalUuid(query.patrolRouteId, 'patrolRouteId', details);
  const scheduleDefinitionId =
    query.scheduleDefinitionId === undefined
      ? undefined
      : readOptionalUuid(
          query.scheduleDefinitionId,
          'scheduleDefinitionId',
          details,
        );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status !== undefined ? { status } : {}),
    ...(buildingId !== undefined && buildingId !== null ? { buildingId } : {}),
    ...(patrolRouteId !== undefined && patrolRouteId !== null
      ? { patrolRouteId }
      : {}),
    ...(scheduleDefinitionId !== undefined && scheduleDefinitionId !== null
      ? { scheduleDefinitionId }
      : {}),
  };
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
): PatrolScheduleBindingStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPatrolScheduleBindingStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${PATROL_SCHEDULE_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

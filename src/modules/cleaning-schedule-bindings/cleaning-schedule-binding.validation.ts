import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  CLEANING_SCHEDULE_BINDING_STATUSES,
  isCleaningScheduleBindingStatus,
  type CleaningScheduleBindingFilter,
  type CleaningScheduleBindingStatus,
  type CreateCleaningScheduleBindingInput,
  type UpdateCleaningScheduleBindingInput,
} from './cleaning-schedule-binding.types';

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

export function parseCleaningScheduleBindingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Cleaning schedule binding id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCleaningAreaIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Cleaning area id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateCleaningScheduleBindingBody(
  body: unknown,
): Omit<CreateCleaningScheduleBindingInput, 'cleaningAreaId' | 'createdByUserId'> {
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

  if (!scheduleDefinitionId && (!targetType || !targetId || !name || !startAt || !timezone)) {
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

export function parseUpdateCleaningScheduleBindingBody(
  body: unknown,
): UpdateCleaningScheduleBindingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

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
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseCleaningScheduleBindingFilter(
  query: Record<string, unknown>,
): CleaningScheduleBindingFilter {
  const details: ValidationDetail[] = [];

  const status =
    query.status === undefined ? undefined : readStatus(query.status, details);
  const buildingId =
    query.buildingId === undefined
      ? undefined
      : readOptionalUuid(query.buildingId, 'buildingId', details);
  const cleaningAreaId =
    query.cleaningAreaId === undefined
      ? undefined
      : readOptionalUuid(query.cleaningAreaId, 'cleaningAreaId', details);
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
    ...(cleaningAreaId !== undefined && cleaningAreaId !== null
      ? { cleaningAreaId }
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
): CleaningScheduleBindingStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isCleaningScheduleBindingStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${CLEANING_SCHEDULE_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

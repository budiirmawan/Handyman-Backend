import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  TOILET_INSPECTION_STATUSES,
  isToiletInspectionStatus,
  type CreateToiletInspectionBindingInput,
  type ToiletInspectionBindingFilter,
  type ToiletInspectionStatus,
  type UpdateToiletInspectionBindingInput,
} from './toilet-inspection.types';

const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseToiletInspectionBindingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Toilet inspection binding id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseToiletInspectionExecutionIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Checklist execution id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateToiletInspectionBindingBody(
  body: unknown,
): Omit<CreateToiletInspectionBindingInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const cleaningAreaId = readRequiredUuid(
    body.cleaningAreaId,
    'cleaningAreaId',
    details,
  );
  const checklistTemplateId = readRequiredUuid(
    body.checklistTemplateId,
    'checklistTemplateId',
    details,
  );
  const roomId = readOptionalUuid(body.roomId, 'roomId', details);
  const functionalLocationId = readOptionalUuid(
    body.functionalLocationId,
    'functionalLocationId',
    details,
  );
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  if (!cleaningAreaId || !checklistTemplateId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    cleaningAreaId,
    checklistTemplateId,
    ...(roomId !== undefined ? { roomId: roomId ?? null } : {}),
    ...(functionalLocationId !== undefined
      ? { functionalLocationId: functionalLocationId ?? null }
      : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseUpdateToiletInspectionBindingBody(
  body: unknown,
): UpdateToiletInspectionBindingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const roomId =
    body.roomId === undefined
      ? undefined
      : readOptionalUuid(body.roomId, 'roomId', details);
  const functionalLocationId =
    body.functionalLocationId === undefined
      ? undefined
      : readOptionalUuid(
          body.functionalLocationId,
          'functionalLocationId',
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
    ...(roomId !== undefined ? { roomId: roomId ?? null } : {}),
    ...(functionalLocationId !== undefined
      ? { functionalLocationId: functionalLocationId ?? null }
      : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseToiletInspectionBindingFilter(
  query: Record<string, unknown>,
): ToiletInspectionBindingFilter {
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

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status !== undefined ? { status } : {}),
    ...(buildingId !== undefined && buildingId !== null ? { buildingId } : {}),
    ...(cleaningAreaId !== undefined && cleaningAreaId !== null
      ? { cleaningAreaId }
      : {}),
  };
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): ToiletInspectionStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isToiletInspectionStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${TOILET_INSPECTION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

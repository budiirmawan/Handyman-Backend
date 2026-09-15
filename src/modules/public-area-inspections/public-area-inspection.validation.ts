import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PUBLIC_AREA_INSPECTION_STATUSES,
  isPublicAreaInspectionStatus,
  type CreatePublicAreaInspectionBindingInput,
  type PublicAreaInspectionBindingFilter,
  type PublicAreaInspectionStatus,
  type UpdatePublicAreaInspectionBindingInput,
} from './public-area-inspection.types';

const MAX_DESCRIPTION_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePublicAreaInspectionBindingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Public area inspection binding id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parsePublicAreaInspectionExecutionIdParam(raw: string): string {
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

export function parseCreatePublicAreaInspectionBindingBody(
  body: unknown,
): Omit<CreatePublicAreaInspectionBindingInput, 'createdByUserId'> {
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
  const floorId = readOptionalUuid(body.floorId, 'floorId', details);
  const areaId = readOptionalUuid(body.areaId, 'areaId', details);
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
    ...(floorId !== undefined ? { floorId: floorId ?? null } : {}),
    ...(areaId !== undefined ? { areaId: areaId ?? null } : {}),
    ...(roomId !== undefined ? { roomId: roomId ?? null } : {}),
    ...(functionalLocationId !== undefined
      ? { functionalLocationId: functionalLocationId ?? null }
      : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseUpdatePublicAreaInspectionBindingBody(
  body: unknown,
): UpdatePublicAreaInspectionBindingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

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
    ...(floorId !== undefined ? { floorId: floorId ?? null } : {}),
    ...(areaId !== undefined ? { areaId: areaId ?? null } : {}),
    ...(roomId !== undefined ? { roomId: roomId ?? null } : {}),
    ...(functionalLocationId !== undefined
      ? { functionalLocationId: functionalLocationId ?? null }
      : {}),
    ...(description !== undefined ? { description } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parsePublicAreaInspectionBindingFilter(
  query: Record<string, unknown>,
): PublicAreaInspectionBindingFilter {
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
): PublicAreaInspectionStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPublicAreaInspectionStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${PUBLIC_AREA_INSPECTION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

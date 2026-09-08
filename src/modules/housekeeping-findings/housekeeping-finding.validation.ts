import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HOUSEKEEPING_FINDING_SOURCE_TYPES,
  isHousekeepingFindingSourceType,
  type CreateHousekeepingFindingInput,
  type HousekeepingFindingFilter,
  type HousekeepingFindingSourceType,
} from './housekeeping-finding.types';

const MAX_TITLE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 1000;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHousekeepingFindingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Finding id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateHousekeepingFindingBody(
  body: unknown,
): CreateHousekeepingFindingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const cleaningAreaId = readRequiredUuid(
    body.cleaningAreaId,
    'cleaningAreaId',
    details,
  );

  let sourceType: HousekeepingFindingSourceType | undefined;
  if (!isHousekeepingFindingSourceType(body.sourceType)) {
    details.push({
      field: 'sourceType',
      message: `sourceType must be one of: ${HOUSEKEEPING_FINDING_SOURCE_TYPES.join(', ')}.`,
    });
  } else {
    sourceType = body.sourceType;
  }

  const sourceId = readRequiredUuid(body.sourceId, 'sourceId', details);

  const title = readRequiredString(
    body.title,
    'title',
    MAX_TITLE_LENGTH,
    details,
  );
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const findingNumber = readOptionalString(
    body.findingNumber,
    'findingNumber',
    64,
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
  const notes = readOptionalString(body.notes, 'notes', 1000, details);

  if (
    !buildingId ||
    !cleaningAreaId ||
    !sourceType ||
    !sourceId ||
    !title ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    cleaningAreaId,
    sourceType,
    sourceId,
    title,
    ...(description !== undefined ? { description } : {}),
    ...(findingNumber !== undefined ? { findingNumber: findingNumber ?? undefined } : {}),
    ...(floorId !== undefined ? { floorId: floorId ?? null } : {}),
    ...(areaId !== undefined ? { areaId: areaId ?? null } : {}),
    ...(roomId !== undefined ? { roomId: roomId ?? null } : {}),
    ...(functionalLocationId !== undefined
      ? { functionalLocationId: functionalLocationId ?? null }
      : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseHousekeepingFindingFilter(
  query: Record<string, unknown>,
): HousekeepingFindingFilter {
  const details: ValidationDetail[] = [];

  const buildingId =
    query.buildingId === undefined
      ? undefined
      : readOptionalUuid(query.buildingId, 'buildingId', details);
  const cleaningAreaId =
    query.cleaningAreaId === undefined
      ? undefined
      : readOptionalUuid(query.cleaningAreaId, 'cleaningAreaId', details);
  const sourceType =
    query.sourceType === undefined
      ? undefined
      : readSourceType(query.sourceType, details);
  const status =
    typeof query.status === 'string' && query.status.trim() !== ''
      ? query.status.trim().toUpperCase()
      : undefined;

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId !== undefined && buildingId !== null ? { buildingId } : {}),
    ...(cleaningAreaId !== undefined && cleaningAreaId !== null
      ? { cleaningAreaId }
      : {}),
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(status !== undefined ? { status } : {}),
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

function readRequiredString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
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

function readSourceType(
  value: unknown,
  details: ValidationDetail[],
): HousekeepingFindingSourceType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isHousekeepingFindingSourceType(value)) {
    details.push({
      field: 'sourceType',
      message: `sourceType must be one of: ${HOUSEKEEPING_FINDING_SOURCE_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

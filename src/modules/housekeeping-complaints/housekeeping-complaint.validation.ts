import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  HOUSEKEEPING_COMPLAINT_BINDING_STATUSES,
  HOUSEKEEPING_COMPLAINT_SOURCE_TYPES,
  isHousekeepingComplaintBindingStatus,
  isHousekeepingComplaintSourceType,
  type CreateHousekeepingComplaintBindingInput,
  type HousekeepingComplaintBindingFilter,
  type HousekeepingComplaintBindingStatus,
  type HousekeepingComplaintSourceType,
  type UpdateHousekeepingComplaintBindingInput,
} from './housekeeping-complaint.types';

const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_REFERENCE_LENGTH = 128;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHousekeepingComplaintBindingIdParam(
  raw: string,
): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Complaint binding id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateHousekeepingComplaintBindingBody(
  body: unknown,
): Omit<CreateHousekeepingComplaintBindingInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const complaintReference = readRequiredString(
    body.complaintReference,
    'complaintReference',
    MAX_REFERENCE_LENGTH,
    details,
  );
  const workRequestId = readOptionalUuid(
    body.workRequestId,
    'workRequestId',
    details,
  );
  const cleaningAreaId = readOptionalUuid(
    body.cleaningAreaId,
    'cleaningAreaId',
    details,
  );

  let housekeepingSourceType: HousekeepingComplaintSourceType | null | undefined;
  if (
    body.housekeepingSourceType !== undefined &&
    body.housekeepingSourceType !== null &&
    body.housekeepingSourceType !== ''
  ) {
    if (!isHousekeepingComplaintSourceType(body.housekeepingSourceType)) {
      details.push({
        field: 'housekeepingSourceType',
        message: `housekeepingSourceType must be one of: ${HOUSEKEEPING_COMPLAINT_SOURCE_TYPES.join(', ')}.`,
      });
    } else {
      housekeepingSourceType = body.housekeepingSourceType;
    }
  }

  const housekeepingSourceId = readOptionalUuid(
    body.housekeepingSourceId,
    'housekeepingSourceId',
    details,
  );

  const findingId = readOptionalUuid(body.findingId, 'findingId', details);
  const description = readOptionalString(
    body.description,
    'description',
    MAX_DESCRIPTION_LENGTH,
    details,
  );
  const status = readStatus(body.status, details);

  if ((housekeepingSourceType && !housekeepingSourceId) || (!housekeepingSourceType && housekeepingSourceId)) {
    details.push({
      field: 'housekeepingSourcePair',
      message:
        'housekeepingSourceType and housekeepingSourceId must both be provided or both omitted.',
    });
  }

  if (!buildingId || !complaintReference || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    complaintReference,
    workRequestId: workRequestId ?? null,
    cleaningAreaId: cleaningAreaId ?? null,
    housekeepingSourceType: housekeepingSourceType ?? null,
    housekeepingSourceId: housekeepingSourceId ?? null,
    findingId: findingId ?? null,
    description: description ?? null,
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseUpdateHousekeepingComplaintBindingBody(
  body: unknown,
): UpdateHousekeepingComplaintBindingInput {
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
  const findingId =
    body.findingId === undefined
      ? undefined
      : readOptionalUuid(body.findingId, 'findingId', details);
  const status = readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(description !== undefined ? { description } : {}),
    ...(findingId !== undefined ? { findingId } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseHousekeepingComplaintBindingFilter(
  query: Record<string, unknown>,
): HousekeepingComplaintBindingFilter {
  const details: ValidationDetail[] = [];

  const buildingId =
    query.buildingId === undefined
      ? undefined
      : readOptionalUuid(query.buildingId, 'buildingId', details);
  const cleaningAreaId =
    query.cleaningAreaId === undefined
      ? undefined
      : readOptionalUuid(query.cleaningAreaId, 'cleaningAreaId', details);
  const findingId =
    query.findingId === undefined
      ? undefined
      : readOptionalUuid(query.findingId, 'findingId', details);
  const workRequestId =
    query.workRequestId === undefined
      ? undefined
      : readOptionalUuid(query.workRequestId, 'workRequestId', details);
  const complaintReference =
    typeof query.complaintReference === 'string' &&
    query.complaintReference.trim() !== ''
      ? query.complaintReference.trim()
      : undefined;
  const status = readStatus(query.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId !== undefined && buildingId !== null ? { buildingId } : {}),
    ...(cleaningAreaId !== undefined && cleaningAreaId !== null
      ? { cleaningAreaId }
      : {}),
    ...(findingId !== undefined && findingId !== null ? { findingId } : {}),
    ...(workRequestId !== undefined && workRequestId !== null
      ? { workRequestId }
      : {}),
    ...(complaintReference !== undefined ? { complaintReference } : {}),
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): HousekeepingComplaintBindingStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isHousekeepingComplaintBindingStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${HOUSEKEEPING_COMPLAINT_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

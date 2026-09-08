import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isPermitStatus,
  PERMIT_STATUSES,
  type PermitStatus,
  type WorkPermitReadinessFilters,
} from './work-permit-readiness.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_TYPE_LENGTH = 100;
const MAX_REFERENCE_LENGTH = 200;
const MAX_NOTES_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePermitReadinessIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'readinessId',
        message: 'Work permit readiness id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

function readUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readRequirementType(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({
      field: 'permitRequirementType',
      message: 'permitRequirementType must be a string.',
    });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === '') {
    details.push({
      field: 'permitRequirementType',
      message: 'permitRequirementType is required.',
    });
    return undefined;
  }
  if (normalized.length > MAX_TYPE_LENGTH) {
    details.push({
      field: 'permitRequirementType',
      message: `permitRequirementType must be at most ${MAX_TYPE_LENGTH} characters.`,
    });
    return undefined;
  }
  return normalized;
}

function readPermitStatus(
  value: unknown,
  details: ValidationDetail[],
): PermitStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isPermitStatus(value)) {
    details.push({
      field: 'permitStatus',
      message: `permitStatus must be one of: ${PERMIT_STATUSES.join(', ')}.`,
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
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
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

function readOptionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  return parsed;
}

export type CreateWorkPermitReadinessBody = {
  vendorWorkId: string;
  permitRequirementType: string;
  permitReference?: string;
  permitStatus?: PermitStatus;
  validFrom?: Date | null;
  validUntil?: Date | null;
  notes?: string;
};

/** Parses the create body (`POST /permit-readiness`). */
export function parseCreateWorkPermitReadinessBody(
  body: unknown,
): CreateWorkPermitReadinessBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const vendorWorkId = readUuid(
    body.vendorWorkId,
    'vendorWorkId',
    'Vendor work id',
    details,
  );
  const permitRequirementType = readRequirementType(
    body.permitRequirementType,
    details,
  );
  const permitReference = readOptionalString(
    body.permitReference,
    'permitReference',
    MAX_REFERENCE_LENGTH,
    details,
  );
  const permitStatus = readPermitStatus(body.permitStatus, details);
  const validFrom = readOptionalDate(body.validFrom, 'validFrom', details);
  const validUntil = readOptionalDate(body.validUntil, 'validUntil', details);
  const notes = readOptionalString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (!vendorWorkId) {
    details.push({
      field: 'vendorWorkId',
      message: 'vendorWorkId is required and must be a valid UUID.',
    });
  }
  if (!permitRequirementType) {
    details.push({
      field: 'permitRequirementType',
      message: 'permitRequirementType is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    vendorWorkId: vendorWorkId as string,
    permitRequirementType: permitRequirementType as string,
    ...(permitReference === undefined ? {} : { permitReference }),
    ...(permitStatus === undefined ? {} : { permitStatus }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export type UpdateWorkPermitReadinessBody = {
  permitReference?: string | null;
  permitStatus?: PermitStatus;
  validFrom?: Date | null;
  validUntil?: Date | null;
  notes?: string | null;
};

/** Parses the update body (`PATCH /permit-readiness/:id`). */
export function parseUpdateWorkPermitReadinessBody(
  body: unknown,
): UpdateWorkPermitReadinessBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let permitReference: string | null | undefined;
  if (body.permitReference === null) {
    permitReference = null;
  } else if (body.permitReference !== undefined) {
    permitReference = readOptionalString(
      body.permitReference,
      'permitReference',
      MAX_REFERENCE_LENGTH,
      details,
    );
  }

  const permitStatus = readPermitStatus(body.permitStatus, details);
  const validFrom = readOptionalDate(body.validFrom, 'validFrom', details);
  const validUntil = readOptionalDate(body.validUntil, 'validUntil', details);

  let notes: string | null | undefined;
  if (body.notes === null) {
    notes = null;
  } else if (body.notes !== undefined) {
    notes = readOptionalString(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  }

  if (
    permitReference === undefined &&
    permitStatus === undefined &&
    validFrom === undefined &&
    validUntil === undefined &&
    notes === undefined
  ) {
    details.push({
      field: 'body',
      message: 'At least one updatable field is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(permitReference === undefined ? {} : { permitReference }),
    ...(permitStatus === undefined ? {} : { permitStatus }),
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * Parses list filters (`GET /permit-readiness?...`). At least one of
 * `vendorWorkId`, `vendorId`, or `buildingId` must be supplied.
 */
export function parseWorkPermitReadinessFilters(
  query: Record<string, unknown>,
): WorkPermitReadinessFilters {
  const details: ValidationDetail[] = [];

  const vendorWorkId = readUuid(
    query.vendorWorkId,
    'vendorWorkId',
    'Vendor work id',
    details,
  );
  const vendorId = readUuid(query.vendorId, 'vendorId', 'Vendor id', details);
  const buildingId = readUuid(
    query.buildingId,
    'buildingId',
    'Building id',
    details,
  );

  if (!vendorWorkId && !vendorId && !buildingId) {
    details.push({
      field: 'filter',
      message: 'Provide at least one of vendorWorkId, vendorId, or buildingId.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(vendorWorkId === undefined ? {} : { vendorWorkId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(buildingId === undefined ? {} : { buildingId }),
  };
}

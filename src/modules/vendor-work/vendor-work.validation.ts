import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isVendorWorkStatus,
  VENDOR_WORK_STATUSES,
  type VendorWorkFilters,
  type VendorWorkStatus,
} from './vendor-work.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_NOTES_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorWorkIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'workId',
        message: 'Work id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

function readUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readOptionalNotes(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    details.push({ field: 'notes', message: 'notes must be a string.' });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (trimmed.length > MAX_NOTES_LENGTH) {
    details.push({
      field: 'notes',
      message: `notes must be at most ${MAX_NOTES_LENGTH} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

/**
 * Parses the optional resolve body (`POST /vendor-assignments/:id/work`).
 * The body may be omitted entirely; only `notes` is accepted.
 */
export function parseResolveVendorWorkBody(
  body: unknown,
): { notes?: string } {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const notes = readOptionalNotes(body.notes, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return notes === undefined ? {} : { notes };
}

/**
 * Parses a status transition body (`PATCH /vendor-works/:id/status`).
 * `status` is required; `notes` is optional.
 */
export function parseUpdateVendorWorkStatusBody(
  body: unknown,
): { status: VendorWorkStatus; notes?: string } {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let status: VendorWorkStatus | undefined;
  if (!isVendorWorkStatus(body.status)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${VENDOR_WORK_STATUSES.join(', ')}.`,
    });
  } else {
    status = body.status;
  }

  const notes = readOptionalNotes(body.notes, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    status: status as VendorWorkStatus,
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * Parses list filters (`GET /vendor-works?...`). At least one of `vendorId`,
 * `buildingId`, or `status` must be supplied.
 */
export function parseVendorWorkFilters(
  query: Record<string, unknown>,
): VendorWorkFilters {
  const details: ValidationDetail[] = [];

  const vendorId = readUuid(query.vendorId, 'vendorId', details);
  const buildingId = readUuid(query.buildingId, 'buildingId', details);

  let status: VendorWorkStatus | undefined;
  if (query.status !== undefined) {
    if (!isVendorWorkStatus(query.status)) {
      details.push({
        field: 'status',
        message: `Status must be one of: ${VENDOR_WORK_STATUSES.join(', ')}.`,
      });
    } else {
      status = query.status;
    }
  }

  if (!vendorId && !buildingId && !status) {
    details.push({
      field: 'filter',
      message: 'Provide at least one of vendorId, buildingId, or status.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(buildingId === undefined ? {} : { buildingId }),
    ...(status === undefined ? {} : { status }),
  };
}

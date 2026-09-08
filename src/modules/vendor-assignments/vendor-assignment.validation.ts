import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isVendorAssignmentStatus,
  VENDOR_ASSIGNMENT_STATUSES,
  type VendorAssignmentFilters,
} from './vendor-assignment.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_NOTES_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorAssignmentIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'assignmentId',
        message: 'Assignment id must be a valid UUID.',
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
 * Parses an assignment payload (`POST /vendor-assignments` and the reassign
 * form of `PATCH /vendor-assignments/:assignmentId`). Both `vendorId` and
 * `workOrderId` are required; `notes` is optional.
 */
export function parseAssignVendorAssignmentBody(
  body: unknown,
): { vendorId: string; workOrderId: string; notes?: string } {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const vendorId = readUuid(body.vendorId, 'vendorId', details);
  const workOrderId = readUuid(body.workOrderId, 'workOrderId', details);
  const notes = readOptionalNotes(body.notes, details);

  if (!vendorId) {
    details.push({
      field: 'vendorId',
      message: 'vendorId is required.',
    });
  }
  if (!workOrderId) {
    details.push({
      field: 'workOrderId',
      message: 'workOrderId is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    vendorId: vendorId as string,
    workOrderId: workOrderId as string,
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * Parses a PATCH assignment body. Two forms are accepted:
 *   - `{ status: 'INACTIVE' }`       → deactivate the assignment
 *   - a vendor/work-order payload    → reassign the assignment
 */
export function parseUpdateVendorAssignmentBody(
  body: unknown,
):
  | { deactivate: true }
  | { reassign: { vendorId: string; workOrderId: string; notes?: string } } {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.status !== undefined) {
    if (!isVendorAssignmentStatus(body.status)) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'status',
          message: `Status must be one of: ${VENDOR_ASSIGNMENT_STATUSES.join(', ')}.`,
        },
      ]);
    }
    if (body.status !== 'INACTIVE') {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'status',
          message: 'Only status INACTIVE is accepted to deactivate an assignment.',
        },
      ]);
    }
    return { deactivate: true };
  }

  return { reassign: parseAssignVendorAssignmentBody(body) };
}

/**
 * Parses list filters (`GET /vendor-assignments?...`). At least one of
 * `vendorId`, `workOrderId`, or `buildingId` must be supplied.
 */
export function parseVendorAssignmentFilters(
  query: Record<string, unknown>,
): VendorAssignmentFilters {
  const details: ValidationDetail[] = [];

  const vendorId = readUuid(query.vendorId, 'vendorId', details);
  const workOrderId = readUuid(query.workOrderId, 'workOrderId', details);
  const buildingId = readUuid(query.buildingId, 'buildingId', details);

  if (!vendorId && !workOrderId && !buildingId) {
    details.push({
      field: 'filter',
      message: 'Provide at least one of vendorId, workOrderId, or buildingId.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(workOrderId === undefined ? {} : { workOrderId }),
    ...(buildingId === undefined ? {} : { buildingId }),
  };
}

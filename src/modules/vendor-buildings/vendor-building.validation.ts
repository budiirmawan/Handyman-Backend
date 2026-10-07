import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_BUILDING_RELATIONSHIP_STATUSES,
  isVendorBuildingRelationshipStatus,
  type VendorBuildingRelationshipStatus,
} from './vendor-building.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export type AssignVendorBuildingBody = {
  buildingId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: VendorBuildingRelationshipStatus;
};

export type UpdateVendorBuildingBody = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: VendorBuildingRelationshipStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'vendorId', message: 'Vendor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseBuildingIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'buildingId', message: 'Building id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseAssignVendorBuildingBody(
  body: unknown,
): AssignVendorBuildingBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readBuildingId(body.buildingId, details);
  const effectiveFrom = readOptionalDate(
    body.effectiveFrom,
    'effectiveFrom',
    details,
  );
  const effectiveUntil = readOptionalDate(
    body.effectiveUntil,
    'effectiveUntil',
    details,
  );
  const status = readStatus(body.status, details);

  assertEffectiveOrder(effectiveFrom, effectiveUntil, details);

  if (!buildingId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVendorBuildingBody(
  body: unknown,
): UpdateVendorBuildingBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const effectiveFrom = readOptionalDate(
    body.effectiveFrom,
    'effectiveFrom',
    details,
  );
  const effectiveUntil = readOptionalDate(
    body.effectiveUntil,
    'effectiveUntil',
    details,
  );
  const status = readStatus(body.status, details);

  // Only checkable here when both bounds are supplied together; a partial
  // update is re-validated in the service against the stored row.
  assertEffectiveOrder(effectiveFrom, effectiveUntil, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

function assertEffectiveOrder(
  effectiveFrom: Date | null | undefined,
  effectiveUntil: Date | null | undefined,
  details: ValidationDetail[],
): void {
  if (
    effectiveFrom instanceof Date &&
    effectiveUntil instanceof Date &&
    effectiveUntil < effectiveFrom
  ) {
    details.push({
      field: 'effectiveUntil',
      message: 'effectiveUntil must be the same as or after effectiveFrom.',
    });
  }
}

function readBuildingId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'buildingId',
      message: 'buildingId is required and must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

/** `null` clears a bound; an ISO-8601 string sets it. */
function readOptionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    details.push({
      field,
      message: `${field} must be an ISO-8601 date string or null.`,
    });
    return undefined;
  }

  const date = new Date(value.trim());
  if (Number.isNaN(date.getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date string.`,
    });
    return undefined;
  }

  return date;
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VendorBuildingRelationshipStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isVendorBuildingRelationshipStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${VENDOR_BUILDING_RELATIONSHIP_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

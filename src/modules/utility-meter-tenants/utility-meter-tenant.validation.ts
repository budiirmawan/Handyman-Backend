import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  UTILITY_METER_TENANT_ASSIGNMENT_STATUSES,
  isUtilityMeterTenantAssignmentStatus,
  type UtilityMeterTenantAssignmentStatus,
} from './utility-meter-tenant.types';

/** BE-18D — Tenant Meter request validation. */

export type ValidationDetail = {
  field: string;
  message: string;
};

export type AssignMeterToTenantBody = {
  tenantCompanyId: string;
  spaceId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: UtilityMeterTenantAssignmentStatus;
};

export type UpdateUtilityMeterTenantAssignmentBody = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: UtilityMeterTenantAssignmentStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(raw: string, field: string, label: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseUtilityMeterTenantAssignmentIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Tenant meter assignment id');
}

export function parseTenantAssignmentMeterIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter id');
}

export function parseTenantAssignmentTenantIdParam(raw: string): string {
  return parseUuidParam(raw, 'tenantCompanyId', 'Tenant company id');
}

export function parseTenantAssignmentSpaceIdParam(raw: string): string {
  return parseUuidParam(raw, 'spaceId', 'Space id');
}

export function parseAssignMeterToTenantBody(
  body: unknown,
): AssignMeterToTenantBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const tenantCompanyId = readRequiredUuid(
    body.tenantCompanyId,
    'tenantCompanyId',
    'Tenant company id',
    details,
  );
  const spaceId = readRequiredUuid(body.spaceId, 'spaceId', 'Space id', details);
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
  const status = readOptionalStatus(body.status, details);

  assertEffectiveOrder(effectiveFrom, effectiveUntil, details);

  if (!tenantCompanyId || !spaceId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    tenantCompanyId,
    spaceId,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateUtilityMeterTenantAssignmentBody(
  body: unknown,
): UpdateUtilityMeterTenantAssignmentBody {
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
  const status = readOptionalStatus(body.status, details);

  // The bound references are immutable: re-assigning a Meter is a new
  // assignment so the previous tenancy survives as history.
  for (const field of ['meterId', 'tenantCompanyId', 'spaceId'] as const) {
    if (body[field] !== undefined) {
      details.push({
        field,
        message:
          'The meter, tenant company, and space are immutable; end this assignment and create a new one instead.',
      });
    }
  }

  // Only checkable here when both bounds arrive together; a partial update is
  // re-checked against the stored record in the service layer.
  assertEffectiveOrder(effectiveFrom, effectiveUntil, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  if (
    effectiveFrom === undefined &&
    effectiveUntil === undefined &&
    status === undefined
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'body',
        message:
          'At least one of effectiveFrom, effectiveUntil, or status must be provided.',
      },
    ]);
  }

  return {
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseEndUtilityMeterTenantAssignmentBody(
  body: unknown,
): UpdateUtilityMeterTenantAssignmentBody {
  if (body === undefined || body === null) {
    return { status: 'INACTIVE' };
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const effectiveUntil = readOptionalDate(
    body.effectiveUntil,
    'effectiveUntil',
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    status: 'INACTIVE',
    ...(effectiveUntil === undefined || effectiveUntil === null
      ? {}
      : { effectiveUntil }),
  };
}

export function parseUtilityMeterTenantAssignmentStatusQuery(
  raw: string | undefined,
): UtilityMeterTenantAssignmentStatus | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityMeterTenantAssignmentStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${UTILITY_METER_TENANT_ASSIGNMENT_STATUSES.join(', ')}.`,
      },
    ]);
  }
  return value;
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
  if (typeof value !== 'string') {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date string.`,
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    details.push({
      field,
      message: `${field} must be a valid ISO-8601 date string.`,
    });
    return undefined;
  }
  return date;
}

function readOptionalStatus(
  value: unknown,
  details: ValidationDetail[],
): UtilityMeterTenantAssignmentStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isUtilityMeterTenantAssignmentStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${UTILITY_METER_TENANT_ASSIGNMENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readRequiredUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${label} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (!isValidUuid(trimmed)) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return trimmed.toLowerCase();
}

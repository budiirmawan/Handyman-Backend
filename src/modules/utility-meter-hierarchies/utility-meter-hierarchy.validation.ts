import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  UTILITY_METER_HIERARCHY_STATUSES,
  isUtilityMeterHierarchyStatus,
  type UtilityMeterHierarchyStatus,
} from './utility-meter-hierarchy.types';

/** BE-18C — Main / Sub Meter hierarchy request validation. */

export type ValidationDetail = {
  field: string;
  message: string;
};

export type BindSubMeterBody = {
  subMeterId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: UtilityMeterHierarchyStatus;
};

export type UpdateUtilityMeterHierarchyBody = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: UtilityMeterHierarchyStatus;
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

export function parseUtilityMeterHierarchyIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter hierarchy id');
}

export function parseHierarchyMeterIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Meter id');
}

export function parseBindSubMeterBody(body: unknown): BindSubMeterBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const subMeterId = readRequiredUuid(
    body.subMeterId,
    'subMeterId',
    'Sub meter id',
    details,
  );
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

  if (!subMeterId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    subMeterId,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateUtilityMeterHierarchyBody(
  body: unknown,
): UpdateUtilityMeterHierarchyBody {
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

  // The bound Meters are immutable: re-pointing a Sub Meter is a new
  // relationship so the previous one survives as history.
  if (body.mainMeterId !== undefined || body.subMeterId !== undefined) {
    details.push({
      field: body.mainMeterId !== undefined ? 'mainMeterId' : 'subMeterId',
      message:
        'The bound meters are immutable; end this relationship and bind a new one instead.',
    });
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

export function parseEndUtilityMeterHierarchyBody(
  body: unknown,
): UpdateUtilityMeterHierarchyBody {
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

export function parseUtilityMeterHierarchyStatusQuery(
  raw: string | undefined,
): UtilityMeterHierarchyStatus | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = raw.trim().toUpperCase();
  if (!isUtilityMeterHierarchyStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${UTILITY_METER_HIERARCHY_STATUSES.join(', ')}.`,
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
): UtilityMeterHierarchyStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isUtilityMeterHierarchyStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${UTILITY_METER_HIERARCHY_STATUSES.join(', ')}.`,
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

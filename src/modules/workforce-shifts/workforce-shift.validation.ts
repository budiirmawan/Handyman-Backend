import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  WORKFORCE_SHIFT_STATUSES,
  isWorkforceShiftStatus,
  type WorkforceShiftStatus,
} from './workforce-shift.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export type AssignWorkforceShiftBody = {
  shiftId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceShiftStatus;
};

export type UpdateWorkforceShiftBody = {
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceShiftStatus;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkforceIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'workforceId', message: 'Workforce id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseShiftIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'shiftId', message: 'Shift id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseAssignWorkforceShiftBody(
  body: unknown,
): AssignWorkforceShiftBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const shiftId = readShiftId(body.shiftId, details);
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

  if (!shiftId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    shiftId,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateWorkforceShiftBody(
  body: unknown,
): UpdateWorkforceShiftBody {
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
  // update is re-checked against the stored record in the service layer.
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

function readShiftId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'shiftId',
      message: 'shiftId is required and must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): WorkforceShiftStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isWorkforceShiftStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${WORKFORCE_SHIFT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

/**
 * Optional effective bound. An explicit `null` is meaningful — it clears the
 * bound — so it is preserved rather than treated as "absent".
 */
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

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  WORKFORCE_REPORTING_LINE_STATUSES,
  isWorkforceReportingLineStatus,
  type WorkforceReportingLineStatus,
} from './workforce-reporting-line.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export type AssignSupervisorBody = {
  supervisorWorkforceProfileId: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceReportingLineStatus;
};

export type UpdateReportingLineBody = {
  supervisorWorkforceProfileId?: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: WorkforceReportingLineStatus;
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

export function parseWorkforceIdParam(raw: string): string {
  return parseUuidParam(raw, 'workforceId', 'Workforce id');
}

export function parseSupervisorIdParam(raw: string): string {
  return parseUuidParam(raw, 'supervisorId', 'Supervisor id');
}

export function parseAssignSupervisorBody(body: unknown): AssignSupervisorBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const supervisorWorkforceProfileId = readSupervisorId(
    body.supervisorWorkforceProfileId,
    details,
    true,
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
  const status = readStatus(body.status, details);

  assertEffectiveOrder(effectiveFrom, effectiveUntil, details);

  if (!supervisorWorkforceProfileId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    supervisorWorkforceProfileId,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateReportingLineBody(
  body: unknown,
): UpdateReportingLineBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const supervisorWorkforceProfileId =
    body.supervisorWorkforceProfileId === undefined
      ? undefined
      : readSupervisorId(body.supervisorWorkforceProfileId, details, false);
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

  // Only checkable here when both bounds arrive together; a partial update is
  // re-checked against the stored record in the service layer.
  assertEffectiveOrder(effectiveFrom, effectiveUntil, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  if (
    supervisorWorkforceProfileId === undefined &&
    effectiveFrom === undefined &&
    effectiveUntil === undefined &&
    status === undefined
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'body',
        message:
          'At least one of supervisorWorkforceProfileId, effectiveFrom, effectiveUntil, or status must be provided.',
      },
    ]);
  }

  return {
    ...(supervisorWorkforceProfileId === undefined
      ? {}
      : { supervisorWorkforceProfileId }),
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

function readSupervisorId(
  value: unknown,
  details: ValidationDetail[],
  required: boolean,
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'supervisorWorkforceProfileId',
      message: required
        ? 'supervisorWorkforceProfileId is required and must be a valid UUID.'
        : 'supervisorWorkforceProfileId must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): WorkforceReportingLineStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isWorkforceReportingLineStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${WORKFORCE_REPORTING_LINE_STATUSES.join(', ')}.`,
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

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  EXTERNAL_WORKFORCE_LINK_STATUSES,
  isExternalWorkforceLinkStatus,
  type ExternalWorkforceLinkStatus,
} from './external-workforce.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

export type CreateExternalWorkforceLinkBody = {
  externalOrganizationId: string;
  externalPersonnelCode: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: ExternalWorkforceLinkStatus;
};

export type UpdateExternalWorkforceLinkBody = {
  externalPersonnelCode?: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: ExternalWorkforceLinkStatus;
};

/**
 * External personnel codes come from the vendor's own systems, so they are
 * more permissive than the BE-03C employee code: 1–64 characters from
 * [A-Za-z0-9], '.', '/', '_' or '-'. They are normalised to trimmed
 * uppercase before persistence, matching the employee-code behaviour.
 */
const PERSONNEL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_PERSONNEL_CODE_LENGTH = 64;

export function normalizeExternalPersonnelCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidExternalPersonnelCode(code: string): boolean {
  return (
    code.length >= 1 &&
    code.length <= MAX_PERSONNEL_CODE_LENGTH &&
    PERSONNEL_CODE_PATTERN.test(code)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseWorkforceProfileIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'workforceId',
        message: 'Workforce id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseExternalOrganizationIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'externalOrganizationId',
        message: 'External organization id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateExternalWorkforceLinkBody(
  body: unknown,
): CreateExternalWorkforceLinkBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const externalOrganizationId = readExternalOrganizationId(
    body.externalOrganizationId,
    details,
  );
  const externalPersonnelCode = readExternalPersonnelCode(
    body.externalPersonnelCode,
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
  const status = readStatus(body.status, details);

  assertEffectiveOrder(effectiveFrom, effectiveUntil, details);

  if (!externalOrganizationId || !externalPersonnelCode || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    externalOrganizationId,
    externalPersonnelCode: normalizeExternalPersonnelCode(
      externalPersonnelCode,
    ),
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateExternalWorkforceLinkBody(
  body: unknown,
): UpdateExternalWorkforceLinkBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const externalPersonnelCode = readOptionalPersonnelCode(
    body.externalPersonnelCode,
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
  const status = readStatus(body.status, details);

  // Only checkable here when both bounds are supplied together; a partial
  // update is re-checked against the stored record in the service layer.
  assertEffectiveOrder(effectiveFrom, effectiveUntil, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  if (
    externalPersonnelCode === undefined &&
    effectiveFrom === undefined &&
    effectiveUntil === undefined &&
    status === undefined
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'body',
        message:
          'At least one of externalPersonnelCode, effectiveFrom, effectiveUntil, or status must be provided.',
      },
    ]);
  }

  return {
    ...(externalPersonnelCode === undefined ? {} : { externalPersonnelCode }),
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

function readExternalOrganizationId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'externalOrganizationId',
      message: 'externalOrganizationId is required and must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readExternalPersonnelCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'externalPersonnelCode',
      message: 'externalPersonnelCode is required.',
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '' || !isValidExternalPersonnelCode(trimmed)) {
    details.push({
      field: 'externalPersonnelCode',
      message: `externalPersonnelCode must be 1-${MAX_PERSONNEL_CODE_LENGTH} characters from [A-Za-z0-9], '.', '/', '_' or '-'.`,
    });
    return undefined;
  }

  return trimmed;
}

function readOptionalPersonnelCode(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    details.push({
      field: 'externalPersonnelCode',
      message: 'externalPersonnelCode must be a string.',
    });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '' || !isValidExternalPersonnelCode(trimmed)) {
    details.push({
      field: 'externalPersonnelCode',
      message: `externalPersonnelCode must be 1-${MAX_PERSONNEL_CODE_LENGTH} characters from [A-Za-z0-9], '.', '/', '_' or '-'.`,
    });
    return undefined;
  }

  return normalizeExternalPersonnelCode(trimmed);
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): ExternalWorkforceLinkStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isExternalWorkforceLinkStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${EXTERNAL_WORKFORCE_LINK_STATUSES.join(', ')}.`,
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

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_WORKFORCE_BINDING_STATUSES,
  isVendorWorkforceBindingStatus,
  type VendorWorkforceBindingStatus,
} from './vendor-workforce.types';

/**
 * Vendor personnel codes follow the BE-03H external personnel code shape:
 * the vendor's own numbering, so more permissive than platform codes —
 * letters, digits, '.', '/', '_' and '-'.
 */
const PERSONNEL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_PERSONNEL_CODE_LENGTH = 64;

export type ValidationDetail = {
  field: string;
  message: string;
};

export type CreateVendorWorkforceBindingBody = {
  workforceProfileId: string;
  vendorPersonnelCode: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: VendorWorkforceBindingStatus;
};

export type UpdateVendorWorkforceBindingBody = {
  vendorPersonnelCode?: string;
  effectiveFrom?: Date | null;
  effectiveUntil?: Date | null;
  status?: VendorWorkforceBindingStatus;
};

export function normalizeVendorPersonnelCode(code: string): string {
  return code.trim().toUpperCase();
}

export function isValidVendorPersonnelCode(code: string): boolean {
  return (
    code.length >= 1 &&
    code.length <= MAX_PERSONNEL_CODE_LENGTH &&
    PERSONNEL_CODE_PATTERN.test(code)
  );
}

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

export function parseWorkforceIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'workforceId', message: 'Workforce id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVendorWorkforceBindingBody(
  body: unknown,
): CreateVendorWorkforceBindingBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const workforceProfileId = readWorkforceProfileId(
    body.workforceProfileId,
    details,
  );
  const vendorPersonnelCode = readPersonnelCode(
    body.vendorPersonnelCode,
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

  if (!workforceProfileId || !vendorPersonnelCode || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    workforceProfileId,
    vendorPersonnelCode,
    ...(effectiveFrom === undefined ? {} : { effectiveFrom }),
    ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateVendorWorkforceBindingBody(
  body: unknown,
): UpdateVendorWorkforceBindingBody {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.vendorId !== undefined || body.workforceProfileId !== undefined) {
    throw AppError.validation('Request validation failed.', [
      {
        field:
          body.vendorId !== undefined ? 'vendorId' : 'workforceProfileId',
        message: 'This field is immutable and cannot be updated.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];

  const vendorPersonnelCode =
    body.vendorPersonnelCode === undefined
      ? undefined
      : readPersonnelCode(body.vendorPersonnelCode, details, false);
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
    ...(vendorPersonnelCode === undefined ? {} : { vendorPersonnelCode }),
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

function readWorkforceProfileId(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'workforceProfileId',
      message: 'workforceProfileId is required and must be a valid UUID.',
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readPersonnelCode(
  value: unknown,
  details: ValidationDetail[],
  required: boolean,
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    if (required || value !== undefined) {
      details.push({
        field: 'vendorPersonnelCode',
        message: `vendorPersonnelCode must be 1-${MAX_PERSONNEL_CODE_LENGTH} characters from [A-Za-z0-9], '.', '/', '_' or '-'.`,
      });
    }
    return undefined;
  }

  const normalized = normalizeVendorPersonnelCode(value);
  if (!isValidVendorPersonnelCode(normalized)) {
    details.push({
      field: 'vendorPersonnelCode',
      message: `vendorPersonnelCode must be 1-${MAX_PERSONNEL_CODE_LENGTH} characters from [A-Za-z0-9], '.', '/', '_' or '-'.`,
    });
    return undefined;
  }

  return normalized;
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
): VendorWorkforceBindingStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isVendorWorkforceBindingStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${VENDOR_WORKFORCE_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

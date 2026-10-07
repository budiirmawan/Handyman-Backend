import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_LICENSE_RECORD_TYPES,
  VENDOR_LICENSE_STATUSES,
  isVendorLicenseRecordType,
  isVendorLicenseStatus,
  type CreateVendorLicenseInput,
  type UpdateVendorLicenseInput,
  type VendorLicenseRecordType,
  type VendorLicenseStatus,
} from './vendor-license.types';

const MAX_NAME_LENGTH = 255;
const MAX_NUMBER_LENGTH = 128;
const MAX_ISSUING_AUTHORITY_LENGTH = 255;
const MAX_NOTES_LENGTH = 1024;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorLicenseIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'vendorLicenseCertificationId',
        message: 'License / certification id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseVendorLicenseVendorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'vendorId', message: 'Vendor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVendorLicenseBody(
  body: unknown,
): Omit<CreateVendorLicenseInput, 'vendorId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const recordType = readRecordType(body.recordType, details);
  const name = readRequiredString(body.name, 'name', MAX_NAME_LENGTH, details);
  const number = readRequiredString(
    body.number,
    'number',
    MAX_NUMBER_LENGTH,
    details,
  );
  const issuingAuthority = readOptionalString(
    body.issuingAuthority,
    'issuingAuthority',
    MAX_ISSUING_AUTHORITY_LENGTH,
    details,
  );
  const issueDate = readOptionalDate(body.issueDate, 'issueDate', details);
  const expiryDate = readOptionalDate(body.expiryDate, 'expiryDate', details);
  const status = readStatus(body.status, details);
  const documentReference = readDocumentReference(
    body.documentReference,
    details,
  );
  const notes = readOptionalString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  assertDateOrder(issueDate, expiryDate, details);

  if (!recordType || !name || !number || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    recordType,
    name,
    number,
    ...(issuingAuthority === undefined ? {} : { issuingAuthority }),
    ...(issueDate === undefined ? {} : { issueDate }),
    ...(expiryDate === undefined ? {} : { expiryDate }),
    ...(status === undefined ? {} : { status }),
    ...(documentReference === undefined ? {} : { documentReference }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateVendorLicenseBody(
  body: unknown,
): UpdateVendorLicenseInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.vendorId !== undefined || body.recordType !== undefined) {
    throw AppError.validation('Request validation failed.', [
      {
        field: body.vendorId !== undefined ? 'vendorId' : 'recordType',
        message: 'This field is immutable and cannot be updated.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name =
    body.name === undefined
      ? undefined
      : readRequiredString(body.name, 'name', MAX_NAME_LENGTH, details);
  const number =
    body.number === undefined
      ? undefined
      : readRequiredString(body.number, 'number', MAX_NUMBER_LENGTH, details);
  const issuingAuthority =
    body.issuingAuthority === null
      ? null
      : readOptionalString(
          body.issuingAuthority,
          'issuingAuthority',
          MAX_ISSUING_AUTHORITY_LENGTH,
          details,
        );
  const issueDate = readOptionalDate(body.issueDate, 'issueDate', details);
  const expiryDate = readOptionalDate(body.expiryDate, 'expiryDate', details);
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);
  const documentReference = readDocumentReference(
    body.documentReference,
    details,
  );
  const notes =
    body.notes === null
      ? null
      : readOptionalString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  // Only checkable here when both bounds are supplied together; a partial
  // update is re-validated in the service against the stored row.
  assertDateOrder(issueDate, expiryDate, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name === undefined ? {} : { name }),
    ...(number === undefined ? {} : { number }),
    ...(issuingAuthority === undefined ? {} : { issuingAuthority }),
    ...(issueDate === undefined ? {} : { issueDate }),
    ...(expiryDate === undefined ? {} : { expiryDate }),
    ...(status === undefined ? {} : { status }),
    ...(documentReference === undefined ? {} : { documentReference }),
    ...(notes === undefined ? {} : { notes }),
  };
}

function assertDateOrder(
  issueDate: Date | null | undefined,
  expiryDate: Date | null | undefined,
  details: ValidationDetail[],
): void {
  if (
    issueDate instanceof Date &&
    expiryDate instanceof Date &&
    expiryDate < issueDate
  ) {
    details.push({
      field: 'expiryDate',
      message: 'expiryDate must be the same as or after issueDate.',
    });
  }
}

function readRecordType(
  value: unknown,
  details: ValidationDetail[],
): VendorLicenseRecordType | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'recordType',
      message: `recordType is required and must be one of: ${VENDOR_LICENSE_RECORD_TYPES.join(', ')}.`,
    });
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  if (!isVendorLicenseRecordType(normalized)) {
    details.push({
      field: 'recordType',
      message: `recordType must be one of: ${VENDOR_LICENSE_RECORD_TYPES.join(', ')}.`,
    });
    return undefined;
  }

  return normalized;
}

function readRequiredString(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    details.push({
      field,
      message: `${field} must be at most ${maxLength} characters.`,
    });
    return undefined;
  }

  return trimmed;
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

/** `null` clears a date; an ISO-8601 string sets it. */
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

/**
 * `documentReference` points at a BE-06G compliance document; explicit
 * null clears the reference.
 */
function readDocumentReference(
  value: unknown,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field: 'documentReference',
      message: 'documentReference must be a valid UUID or null.',
    });
    return undefined;
  }

  return value.trim().toLowerCase();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VendorLicenseStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isVendorLicenseStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${VENDOR_LICENSE_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VENDOR_COMPLIANCE_DOCUMENT_STATUSES,
  isVendorComplianceDocumentStatus,
  type CreateVendorComplianceDocumentInput,
  type UpdateVendorComplianceDocumentInput,
  type VendorComplianceDocumentStatus,
} from './vendor-compliance-document.types';

/**
 * Document types are machine-readable classifiers (e.g. `BUSINESS_LICENSE`,
 * `TAX_CLEARANCE`, `INSURANCE_CERTIFICATE`), normalized to uppercase like
 * every other code in the system. Document numbers keep the issuer's own
 * formatting (only trimmed) — issuers use arbitrary shapes.
 */
const DOCUMENT_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;
const MAX_DOCUMENT_TYPE_LENGTH = 64;
const MAX_DOCUMENT_NUMBER_LENGTH = 128;
const MAX_DOCUMENT_NAME_LENGTH = 255;
const MAX_FILE_REFERENCE_LENGTH = 512;
const MAX_NOTES_LENGTH = 1024;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeDocumentType(value: string): string {
  return value.trim().toUpperCase();
}

export function isValidDocumentType(value: string): boolean {
  return (
    value.length >= 2 &&
    value.length <= MAX_DOCUMENT_TYPE_LENGTH &&
    DOCUMENT_TYPE_PATTERN.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVendorComplianceDocumentIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'vendorComplianceDocumentId',
        message: 'Vendor compliance document id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseVendorComplianceVendorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'vendorId', message: 'Vendor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVendorComplianceDocumentBody(
  body: unknown,
): Omit<CreateVendorComplianceDocumentInput, 'vendorId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const documentType = readDocumentType(body.documentType, details, true);
  const documentNumber = readDocumentNumber(body.documentNumber, details, true);
  const documentName = readDocumentName(body.documentName, details, true);
  const issueDate = readOptionalDate(body.issueDate, 'issueDate', details);
  const expiryDate = readOptionalDate(body.expiryDate, 'expiryDate', details);
  const status = readStatus(body.status, details);
  const fileReference = readOptionalString(
    body.fileReference,
    'fileReference',
    MAX_FILE_REFERENCE_LENGTH,
    details,
  );
  const notes = readOptionalString(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  assertDateOrder(issueDate, expiryDate, details);

  if (!documentType || !documentNumber || !documentName || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    documentType,
    documentNumber,
    documentName,
    ...(issueDate === undefined ? {} : { issueDate }),
    ...(expiryDate === undefined ? {} : { expiryDate }),
    ...(status === undefined ? {} : { status }),
    ...(fileReference === undefined ? {} : { fileReference }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function parseUpdateVendorComplianceDocumentBody(
  body: unknown,
): UpdateVendorComplianceDocumentInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  if (body.vendorId !== undefined) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'vendorId',
        message: 'This field is immutable and cannot be updated.',
      },
    ]);
  }

  const details: ValidationDetail[] = [];

  const documentType =
    body.documentType === undefined
      ? undefined
      : readDocumentType(body.documentType, details, false);
  const documentNumber =
    body.documentNumber === undefined
      ? undefined
      : readDocumentNumber(body.documentNumber, details, false);
  const documentName =
    body.documentName === undefined
      ? undefined
      : readDocumentName(body.documentName, details, false);
  const issueDate = readOptionalDate(body.issueDate, 'issueDate', details);
  const expiryDate = readOptionalDate(body.expiryDate, 'expiryDate', details);
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);
  const fileReference =
    body.fileReference === null
      ? null
      : readOptionalString(
          body.fileReference,
          'fileReference',
          MAX_FILE_REFERENCE_LENGTH,
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
    ...(documentType === undefined ? {} : { documentType }),
    ...(documentNumber === undefined ? {} : { documentNumber }),
    ...(documentName === undefined ? {} : { documentName }),
    ...(issueDate === undefined ? {} : { issueDate }),
    ...(expiryDate === undefined ? {} : { expiryDate }),
    ...(status === undefined ? {} : { status }),
    ...(fileReference === undefined ? {} : { fileReference }),
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

function readDocumentType(
  value: unknown,
  details: ValidationDetail[],
  required: boolean,
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    if (required || value !== undefined) {
      details.push({
        field: 'documentType',
        message: 'documentType is required.',
      });
    }
    return undefined;
  }

  const normalized = normalizeDocumentType(value);
  if (!isValidDocumentType(normalized)) {
    details.push({
      field: 'documentType',
      message:
        'documentType must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readDocumentNumber(
  value: unknown,
  details: ValidationDetail[],
  required: boolean,
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    if (required || value !== undefined) {
      details.push({
        field: 'documentNumber',
        message: 'documentNumber is required.',
      });
    }
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length > MAX_DOCUMENT_NUMBER_LENGTH) {
    details.push({
      field: 'documentNumber',
      message: `documentNumber must be at most ${MAX_DOCUMENT_NUMBER_LENGTH} characters.`,
    });
    return undefined;
  }

  return trimmed;
}

function readDocumentName(
  value: unknown,
  details: ValidationDetail[],
  required: boolean,
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    if (required || value !== undefined) {
      details.push({
        field: 'documentName',
        message: 'documentName is required.',
      });
    }
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length > MAX_DOCUMENT_NAME_LENGTH) {
    details.push({
      field: 'documentName',
      message: `documentName must be at most ${MAX_DOCUMENT_NAME_LENGTH} characters.`,
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): VendorComplianceDocumentStatus | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isVendorComplianceDocumentStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${VENDOR_COMPLIANCE_DOCUMENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

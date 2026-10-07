import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  ASSET_CERTIFICATION_STATUSES,
  isAssetCertificationStatus,
  type AssetCertificationStatus,
  type CreateAssetCertificationInput,
  type UpdateAssetCertificationInput,
  type UpdateAssetCertificationStatusInput,
} from './asset-certification.types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Certification types are a machine-readable classification
 * (e.g. `STATUTORY_PERMIT`, `LOAD_TEST`, `FIRE_SAFETY`). Normalized to
 * uppercase, matching every other code in the system: start with a letter;
 * letters, digits, hyphens, underscores.
 *
 * The type is DATA, not behavior: no application logic branches on a
 * specific certification type.
 */
const CERTIFICATION_TYPE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;

const MAX_TYPE_LENGTH = 64;
const MAX_CERTIFICATE_NUMBER_LENGTH = 120;
const MAX_ISSUING_AUTHORITY_LENGTH = 160;
const MAX_NOTES_LENGTH = 2048;

export type ValidationDetail = {
  field: string;
  message: string;
};

export function normalizeCertificationType(type: string): string {
  return type.trim().toUpperCase();
}

export function isValidCertificationType(type: string): boolean {
  return (
    type.length >= 2 &&
    type.length <= MAX_TYPE_LENGTH &&
    CERTIFICATION_TYPE_PATTERN.test(type)
  );
}

/**
 * Certificate numbers come from the issuing authority's document, so they
 * are NOT forced into the internal code shape: original case preserved, dots
 * and slashes allowed. Only trimmed and length-checked.
 */
export function normalizeCertificateNumber(certificateNumber: string): string {
  return certificateNumber.trim();
}

/** True for a real `YYYY-MM-DD` calendar date (rejects 2023-02-29). */
export function isValidCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  return date.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCertificationAssetIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'assetId', message: 'Asset id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCertificationIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'certificationId',
        message: 'Certification id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

/** Optional `?status=` filter on the certification history route. */
export function parseCertificationStatusQuery(
  raw: unknown,
): AssetCertificationStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Array.isArray(raw) ? '' : String(raw).trim().toUpperCase();
  if (value === '') {
    return undefined;
  }

  if (!isAssetCertificationStatus(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${ASSET_CERTIFICATION_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return value;
}

/** Optional `?type=` filter on the certification history route. */
export function parseCertificationTypeQuery(
  raw: unknown,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Array.isArray(raw) ? '' : String(raw).trim();
  if (value === '') {
    return undefined;
  }

  const normalized = normalizeCertificationType(value);
  if (!isValidCertificationType(normalized)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'type',
        message:
          'type must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
      },
    ]);
  }

  return normalized;
}

export function parseCreateAssetCertificationBody(
  body: unknown,
): Omit<CreateAssetCertificationInput, 'assetId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const certificationType = readCertificationType(
    body.certificationType,
    details,
  );
  const certificateNumber = readRequiredText(
    body.certificateNumber,
    'certificateNumber',
    MAX_CERTIFICATE_NUMBER_LENGTH,
    details,
  );
  const issuingAuthority = readRequiredText(
    body.issuingAuthority,
    'issuingAuthority',
    MAX_ISSUING_AUTHORITY_LENGTH,
    details,
  );
  const issueDate = readRequiredDate(body.issueDate, 'issueDate', details);
  const expiryDate = readOptionalDate(body.expiryDate, 'expiryDate', details);
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  const status = readStatus(body.status, details);

  assertDateRange(issueDate, expiryDate, details);

  if (
    !certificationType ||
    !certificateNumber ||
    !issuingAuthority ||
    !issueDate ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    certificationType,
    certificateNumber,
    issuingAuthority,
    issueDate,
    ...(expiryDate === undefined ? {} : { expiryDate }),
    ...(notes === undefined ? {} : { notes }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateAssetCertificationBody(
  body: unknown,
): UpdateAssetCertificationInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const certificationType =
    body.certificationType === undefined
      ? undefined
      : readCertificationType(body.certificationType, details);
  const certificateNumber =
    body.certificateNumber === undefined
      ? undefined
      : readRequiredText(
          body.certificateNumber,
          'certificateNumber',
          MAX_CERTIFICATE_NUMBER_LENGTH,
          details,
        );
  const issuingAuthority =
    body.issuingAuthority === undefined
      ? undefined
      : readRequiredText(
          body.issuingAuthority,
          'issuingAuthority',
          MAX_ISSUING_AUTHORITY_LENGTH,
          details,
        );
  const issueDate =
    body.issueDate === undefined
      ? undefined
      : readRequiredDate(body.issueDate, 'issueDate', details);
  const expiryDate = readNullableDate(body.expiryDate, 'expiryDate', details);
  const notes = readNullableText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  const status =
    body.status === undefined ? undefined : readStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(certificationType === undefined ? {} : { certificationType }),
    ...(certificateNumber === undefined ? {} : { certificateNumber }),
    ...(issuingAuthority === undefined ? {} : { issuingAuthority }),
    ...(issueDate === undefined ? {} : { issueDate }),
    ...(expiryDate === undefined ? {} : { expiryDate }),
    ...(notes === undefined ? {} : { notes }),
    ...(status === undefined ? {} : { status }),
  };
}

export function parseUpdateAssetCertificationStatusBody(
  body: unknown,
): UpdateAssetCertificationStatusInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const status = readStatus(body.status, []);
  if (!status) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'status',
        message: `Status must be one of: ${ASSET_CERTIFICATION_STATUSES.join(', ')}.`,
      },
    ]);
  }

  return { status };
}

/**
 * A perpetual certification has no expiry; when one exists it can never
 * precede the issue date. Mirrors the DB CHECK constraint.
 */
export function assertDateRange(
  issueDate: string | undefined,
  expiryDate: string | null | undefined,
  details: ValidationDetail[],
): void {
  if (issueDate && expiryDate && expiryDate < issueDate) {
    details.push({
      field: 'expiryDate',
      message: 'expiryDate cannot be earlier than issueDate.',
    });
  }
}

function readCertificationType(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({
      field: 'certificationType',
      message: 'certificationType is required.',
    });
    return undefined;
  }

  const normalized = normalizeCertificationType(value);
  if (!isValidCertificationType(normalized)) {
    details.push({
      field: 'certificationType',
      message:
        'certificationType must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).',
    });
    return undefined;
  }

  return normalized;
}

function readRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    details.push({ field, message: `${field} is required.` });
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

function readOptionalText(
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

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
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

function dateMessage(field: string): string {
  return `${field} must be a valid calendar date in YYYY-MM-DD format.`;
}

function readRequiredDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidCalendarDate(value.trim())) {
    details.push({ field, message: dateMessage(field) });
    return undefined;
  }

  return value.trim();
}

function readOptionalDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string' || !isValidCalendarDate(value.trim())) {
    details.push({ field, message: dateMessage(field) });
    return undefined;
  }

  return value.trim();
}

/** An explicit null marks the certification perpetual. */
function readNullableDate(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string' || !isValidCalendarDate(value.trim())) {
    details.push({ field, message: dateMessage(field) });
    return undefined;
  }

  return value.trim();
}

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): AssetCertificationStatus | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isAssetCertificationStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${ASSET_CERTIFICATION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }

  return value;
}

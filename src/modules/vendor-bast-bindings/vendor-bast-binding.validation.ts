import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidDateFormat } from '../daily-cleaning';
import type { VendorBastFilters } from './vendor-bast-binding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_NUMBER_LENGTH = 100;
const MAX_NOTES_LENGTH = 4000;
const MAX_REF_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseBastIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'bastId',
        message: 'BAST id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

function readUuid(
  value: unknown,
  field: string,
  label: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${label} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
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

function readOptionalText(
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
    details.push({ field, message: `${field} must be a string.` });
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

function readBastDate(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidDateFormat(value.trim())) {
    details.push({
      field: 'bastDate',
      message: 'bastDate must be a valid YYYY-MM-DD format.',
    });
    return undefined;
  }
  return value.trim();
}

/** Parses the create body (`POST /vendor-basts`). */
export function parseCreateBastBody(
  body: unknown,
): {
  vendorWorkId: string;
  bastNumber: string;
  bastDate: string;
  notes?: string | null;
  fileReference?: string | null;
} {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const vendorWorkId = readUuid(
    body.vendorWorkId,
    'vendorWorkId',
    'Vendor work id',
    details,
  );
  const bastNumber = readRequiredString(
    body.bastNumber,
    'bastNumber',
    MAX_NUMBER_LENGTH,
    details,
  );
  const bastDate = readBastDate(body.bastDate, details);
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);
  const fileReference = readOptionalText(
    body.fileReference,
    'fileReference',
    MAX_REF_LENGTH,
    details,
  );

  if (!vendorWorkId) {
    details.push({
      field: 'vendorWorkId',
      message: 'vendorWorkId is required and must be a valid UUID.',
    });
  }
  if (!bastDate) {
    details.push({
      field: 'bastDate',
      message: 'bastDate is required and must be a valid YYYY-MM-DD format.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    vendorWorkId: vendorWorkId as string,
    bastNumber: bastNumber as string,
    bastDate: bastDate as string,
    ...(notes === undefined ? {} : { notes }),
    ...(fileReference === undefined ? {} : { fileReference }),
  };
}

/** Parses legacy submit delegation (`{ documentVersionId }`). */
export function parseSubmitBastBody(body: unknown): {
  documentVersionId: string;
} {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const details: ValidationDetail[] = [];
  const documentVersionId = readUuid(
    body.documentVersionId,
    'documentVersionId',
    'Document version id',
    details,
  );
  if (!documentVersionId) {
    details.push({
      field: 'documentVersionId',
      message: 'documentVersionId is required and must be a valid UUID.',
    });
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
  return { documentVersionId: documentVersionId as string };
}

/** Parses the accept/reject decision body (`{ notes? }`). */
export function parseBastDecisionBody(
  body: unknown,
): { notes?: string | null } {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return notes === undefined ? {} : { notes };
}

/**
 * Parses list filters (`GET /vendor-basts?...`). At least one of
 * `vendorWorkId`, `vendorId`, or `buildingId` must be supplied.
 */
export function parseBastFilters(
  query: Record<string, unknown>,
): VendorBastFilters {
  const details: ValidationDetail[] = [];

  const vendorWorkId = readUuid(
    query.vendorWorkId,
    'vendorWorkId',
    'Vendor work id',
    details,
  );
  const vendorId = readUuid(query.vendorId, 'vendorId', 'Vendor id', details);
  const buildingId = readUuid(
    query.buildingId,
    'buildingId',
    'Building id',
    details,
  );

  if (!vendorWorkId && !vendorId && !buildingId) {
    details.push({
      field: 'filter',
      message: 'Provide at least one of vendorWorkId, vendorId, or buildingId.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(vendorWorkId === undefined ? {} : { vendorWorkId }),
    ...(vendorId === undefined ? {} : { vendorId }),
    ...(buildingId === undefined ? {} : { buildingId }),
  };
}

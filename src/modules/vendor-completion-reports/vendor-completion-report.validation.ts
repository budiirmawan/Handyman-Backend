import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { VendorCompletionReportFilters } from './vendor-completion-report.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_SUMMARY_LENGTH = 4000;
const MAX_NOTES_LENGTH = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseCompletionReportIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'reportId',
        message: 'Completion report id must be a valid UUID.',
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

/** Parses the create body (`POST /vendor-completion-reports`). */
export function parseCreateCompletionReportBody(
  body: unknown,
): { vendorWorkId: string; summary?: string | null; notes?: string | null } {
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
  const summary = readOptionalText(
    body.summary,
    'summary',
    MAX_SUMMARY_LENGTH,
    details,
  );
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (!vendorWorkId) {
    details.push({
      field: 'vendorWorkId',
      message: 'vendorWorkId is required and must be a valid UUID.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    vendorWorkId: vendorWorkId as string,
    ...(summary === undefined ? {} : { summary }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/** Parses the update body (`PATCH /vendor-completion-reports/:id`). */
export function parseUpdateCompletionReportBody(
  body: unknown,
): { summary?: string | null; notes?: string | null } {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const summary = readOptionalText(
    body.summary,
    'summary',
    MAX_SUMMARY_LENGTH,
    details,
  );
  const notes = readOptionalText(body.notes, 'notes', MAX_NOTES_LENGTH, details);

  if (summary === undefined && notes === undefined) {
    details.push({
      field: 'body',
      message: 'At least one of summary or notes is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(summary === undefined ? {} : { summary }),
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * Parses list filters (`GET /vendor-completion-reports?...`). At least one of
 * `vendorWorkId`, `vendorId`, or `buildingId` must be supplied.
 */
export function parseCompletionReportFilters(
  query: Record<string, unknown>,
): VendorCompletionReportFilters {
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

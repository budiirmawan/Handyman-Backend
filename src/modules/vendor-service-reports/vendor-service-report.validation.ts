import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidDateFormat } from '../daily-cleaning';
import type { VendorServiceReportFilters } from './vendor-service-report.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_NUMBER_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 4000;
const MAX_WORK_PERFORMED_LENGTH = 8000;
const MAX_RECOMMENDATION_LENGTH = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseServiceReportIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'reportId',
        message: 'Service report id must be a valid UUID.',
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

function readServiceDate(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidDateFormat(value.trim())) {
    details.push({
      field: 'serviceDate',
      message: 'serviceDate must be a valid YYYY-MM-DD format.',
    });
    return undefined;
  }
  return value.trim();
}

/** Parses the create body (`POST /vendor-service-reports`). */
export function parseCreateServiceReportBody(
  body: unknown,
): {
  vendorWorkId: string;
  serviceReportNumber: string;
  serviceDate: string;
  summary?: string | null;
  workPerformed?: string | null;
  recommendation?: string | null;
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
  const serviceReportNumber = readRequiredString(
    body.serviceReportNumber,
    'serviceReportNumber',
    MAX_NUMBER_LENGTH,
    details,
  );
  const serviceDate = readServiceDate(body.serviceDate, details);
  const summary = readOptionalText(body.summary, 'summary', MAX_SUMMARY_LENGTH, details);
  const workPerformed = readOptionalText(
    body.workPerformed,
    'workPerformed',
    MAX_WORK_PERFORMED_LENGTH,
    details,
  );
  const recommendation = readOptionalText(
    body.recommendation,
    'recommendation',
    MAX_RECOMMENDATION_LENGTH,
    details,
  );

  if (!vendorWorkId) {
    details.push({
      field: 'vendorWorkId',
      message: 'vendorWorkId is required and must be a valid UUID.',
    });
  }
  if (!serviceDate) {
    details.push({
      field: 'serviceDate',
      message: 'serviceDate is required and must be a valid YYYY-MM-DD format.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    vendorWorkId: vendorWorkId as string,
    serviceReportNumber: serviceReportNumber as string,
    serviceDate: serviceDate as string,
    ...(summary === undefined ? {} : { summary }),
    ...(workPerformed === undefined ? {} : { workPerformed }),
    ...(recommendation === undefined ? {} : { recommendation }),
  };
}

/** Parses the update body (`PATCH /vendor-service-reports/:id`). */
export function parseUpdateServiceReportBody(
  body: unknown,
): {
  serviceDate?: string;
  summary?: string | null;
  workPerformed?: string | null;
  recommendation?: string | null;
} {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const serviceDate = readServiceDate(body.serviceDate, details);
  const summary = readOptionalText(body.summary, 'summary', MAX_SUMMARY_LENGTH, details);
  const workPerformed = readOptionalText(
    body.workPerformed,
    'workPerformed',
    MAX_WORK_PERFORMED_LENGTH,
    details,
  );
  const recommendation = readOptionalText(
    body.recommendation,
    'recommendation',
    MAX_RECOMMENDATION_LENGTH,
    details,
  );

  if (
    serviceDate === undefined &&
    summary === undefined &&
    workPerformed === undefined &&
    recommendation === undefined
  ) {
    details.push({
      field: 'body',
      message:
        'At least one of serviceDate, summary, workPerformed, or recommendation is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(serviceDate === undefined ? {} : { serviceDate }),
    ...(summary === undefined ? {} : { summary }),
    ...(workPerformed === undefined ? {} : { workPerformed }),
    ...(recommendation === undefined ? {} : { recommendation }),
  };
}

/**
 * Parses list filters (`GET /vendor-service-reports?...`). At least one of
 * `vendorWorkId`, `vendorId`, or `buildingId` must be supplied.
 */
export function parseServiceReportFilters(
  query: Record<string, unknown>,
): VendorServiceReportFilters {
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

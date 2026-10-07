import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  UTILITY_METER_READING_EVIDENCE_TYPES,
  isUtilityMeterReadingEvidenceType,
  type SubmitUtilityMeterReadingEvidenceInput,
  type UtilityMeterReadingEvidenceFilters,
  type UtilityMeterReadingEvidenceType,
} from './utility-meter-reading-evidence.types';

/** BE-18F — Reading Evidence request validation. */

const MAX_FILE_SIZE = 52_428_800; // 50 MB, matching BE-07.
const MAX_NAME_LENGTH = 255;
const MAX_REF_LENGTH = 512;

export type ValidationDetail = {
  field: string;
  message: string;
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

export function parseReadingEvidenceReadingIdParam(raw: string): string {
  return parseUuidParam(raw, 'meterReadingId', 'Meter reading id');
}

export function parseReadingEvidenceIdParam(raw: string): string {
  return parseUuidParam(raw, 'evidenceId', 'Evidence id');
}

export function parseSubmitReadingEvidenceBody(
  body: unknown,
): Omit<
  SubmitUtilityMeterReadingEvidenceInput,
  'meterReadingId' | 'clientId' | 'submittedByUserId'
> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const evidenceType = readEvidenceType(body.evidenceType, details);
  const evidenceRequirementId =
    body.evidenceRequirementId === undefined
      ? undefined
      : readOptionalUuid(
          body.evidenceRequirementId,
          'evidenceRequirementId',
          details,
        );
  const fileReference = readRequiredString(
    body.fileReference,
    'fileReference',
    MAX_REF_LENGTH,
    details,
  );
  const originalFileName = readRequiredString(
    body.originalFileName,
    'originalFileName',
    MAX_NAME_LENGTH,
    details,
  );
  const mimeType = readRequiredString(
    body.mimeType,
    'mimeType',
    MAX_NAME_LENGTH,
    details,
  );
  const fileSize = readFileSize(body.fileSize, details);
  const capturedAt = readOptionalTimestamp(body.capturedAt, details);

  if (
    !evidenceType ||
    !fileReference ||
    !originalFileName ||
    !mimeType ||
    fileSize === undefined ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    evidenceType,
    ...(evidenceRequirementId === undefined ? {} : { evidenceRequirementId }),
    fileReference,
    originalFileName,
    mimeType,
    fileSize,
    ...(capturedAt === undefined ? {} : { capturedAt }),
  };
}

/**
 * Parses list filters (`GET /utility/meter-reading-evidence?...`). At least
 * one of `meterReadingId`, `meterId`, or `buildingId` must be supplied so a
 * listing is always anchored to an authoritative scope.
 */
export function parseReadingEvidenceFilters(
  query: Record<string, unknown>,
): UtilityMeterReadingEvidenceFilters {
  const details: ValidationDetail[] = [];

  const meterReadingId = readOptionalUuid(
    query.meterReadingId,
    'meterReadingId',
    details,
  );
  const meterId = readOptionalUuid(query.meterId, 'meterId', details);
  const buildingId = readOptionalUuid(query.buildingId, 'buildingId', details);

  if (!meterReadingId && !meterId && !buildingId) {
    details.push({
      field: 'filter',
      message:
        'Provide at least one of meterReadingId, meterId, or buildingId.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(meterReadingId === undefined ? {} : { meterReadingId }),
    ...(meterId === undefined ? {} : { meterId }),
    ...(buildingId === undefined ? {} : { buildingId }),
  };
}

function readEvidenceType(
  value: unknown,
  details: ValidationDetail[],
): UtilityMeterReadingEvidenceType | undefined {
  if (!isUtilityMeterReadingEvidenceType(value)) {
    details.push({
      field: 'evidenceType',
      message: `Evidence type must be one of: ${UTILITY_METER_READING_EVIDENCE_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
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

/** `captured_at` is a real timestamp column, so reject unparseable input. */
function readOptionalTimestamp(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({
      field: 'capturedAt',
      message: 'capturedAt must be a valid ISO-8601 date string.',
    });
    return undefined;
  }
  const trimmed = value.trim();
  if (Number.isNaN(new Date(trimmed).getTime())) {
    details.push({
      field: 'capturedAt',
      message: 'capturedAt must be a valid ISO-8601 date string.',
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readFileSize(
  value: unknown,
  details: ValidationDetail[],
): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_FILE_SIZE
  ) {
    details.push({
      field: 'fileSize',
      message: `fileSize must be an integer between 0 and ${MAX_FILE_SIZE}.`,
    });
    return undefined;
  }
  return value;
}

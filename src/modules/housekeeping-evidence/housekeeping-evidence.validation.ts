import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  EVIDENCE_TYPES,
  HOUSEKEEPING_EVIDENCE_SOURCE_TYPES,
  isEvidenceType,
  isHousekeepingEvidenceSourceType,
  type EvidenceType,
  type HousekeepingEvidenceSourceType,
  type SubmitHousekeepingEvidenceInput,
} from './housekeeping-evidence.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const ALLOWED_MIME_TYPES: Record<EvidenceType, string[]> = {
  PHOTO: ['image/jpeg', 'image/png', 'image/webp'],
  SIGNATURE: ['image/png', 'image/svg+xml'],
  DOCUMENT: ['application/pdf', 'image/jpeg', 'image/png'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseHousekeepingEvidenceSourceTypeParam(
  raw: string,
): HousekeepingEvidenceSourceType {
  const value = raw.trim().toLowerCase();
  if (!isHousekeepingEvidenceSourceType(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'sourceType',
        message: `sourceType must be one of: ${HOUSEKEEPING_EVIDENCE_SOURCE_TYPES.join(', ')}.`,
      },
    ]);
  }
  return value;
}

export function parseHousekeepingEvidenceSourceIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'sourceId', message: 'Source id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseSubmitHousekeepingEvidenceBody(
  body: unknown,
): Omit<
  SubmitHousekeepingEvidenceInput,
  'sourceType' | 'sourceId' | 'submittedByUserId'
> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let evidenceType: EvidenceType | undefined;
  if (!isEvidenceType(body.evidenceType)) {
    details.push({
      field: 'evidenceType',
      message: `evidenceType must be one of: ${EVIDENCE_TYPES.join(', ')}.`,
    });
  } else {
    evidenceType = body.evidenceType;
  }

  const evidenceRequirementId = readOptionalUuid(
    body.evidenceRequirementId,
    'evidenceRequirementId',
    details,
  );

  const fileReference = readRequiredString(
    body.fileReference,
    'fileReference',
    512,
    details,
  );

  const originalFileName = readRequiredString(
    body.originalFileName,
    'originalFileName',
    256,
    details,
  );

  const mimeType = readRequiredString(
    body.mimeType,
    'mimeType',
    128,
    details,
  );

  let fileSize: number | undefined;
  if (
    typeof body.fileSize !== 'number' ||
    !Number.isInteger(body.fileSize) ||
    body.fileSize < 0 ||
    body.fileSize > 52428800
  ) {
    details.push({
      field: 'fileSize',
      message: 'fileSize must be an integer between 0 and 52428800 bytes (50MB).',
    });
  } else {
    fileSize = body.fileSize;
  }

  if (evidenceType && mimeType) {
    const allowed = ALLOWED_MIME_TYPES[evidenceType];
    if (!allowed || !allowed.includes(mimeType)) {
      details.push({
        field: 'mimeType',
        message: `MIME type ${mimeType} is not supported for evidence type ${evidenceType}.`,
      });
    }
  }

  const capturedAt =
    typeof body.capturedAt === 'string' && body.capturedAt.trim() !== ''
      ? body.capturedAt.trim()
      : undefined;

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
    evidenceRequirementId: evidenceRequirementId ?? null,
    fileReference,
    originalFileName,
    mimeType,
    fileSize,
    ...(capturedAt !== undefined ? { capturedAt } : {}),
  };
}

function readRequiredString(
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

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
}

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  VISITOR_IDENTITY_TYPES,
  isVisitorIdentityType,
  type VisitorIdentityType,
} from '../visitors';
import {
  VISITOR_PHOTO_OCR_STATUSES,
  VISITOR_PHOTO_REVIEW_STATUSES,
  VISITOR_PHOTO_STATUSES,
  VISITOR_PHOTO_TYPES,
  isVisitorPhotoOcrStatus,
  isVisitorPhotoReviewStatus,
  isVisitorPhotoStatus,
  isVisitorPhotoType,
  type CreateVisitorPhotoInput,
  type RecordVisitorPhotoOcrResultInput,
  type ReviewVisitorPhotoInput,
  type VisitorPhotoListFilters,
} from './visitor-photo.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

const MAX_FILE_REFERENCE_LENGTH = 1024;
const MAX_FILE_NAME_LENGTH = 256;
const MAX_MIME_LENGTH = 128;
const MAX_PROVIDER_LENGTH = 128;
const MAX_ERROR_LENGTH = 2048;
const MAX_NAME_LENGTH = 256;
const MAX_IDENTITY_NUMBER_LENGTH = 128;
const MAX_FILE_SIZE = 52_428_800; // 50 MB — matches BE-07 evidence limit.

const IMAGE_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseVisitorPhotoIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'id', message: 'Visitor photo id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseVisitorPhotoVisitorIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'visitorId', message: 'Visitor id must be a valid UUID.' },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateVisitorPhotoBody(
  body: unknown,
): Omit<CreateVisitorPhotoInput, 'visitorId' | 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const photoType = readPhotoType(body.photoType, details);
  const fileReference = readRequiredText(
    body.fileReference,
    'fileReference',
    MAX_FILE_REFERENCE_LENGTH,
    details,
  );
  const originalFileName = readRequiredText(
    body.originalFileName,
    'originalFileName',
    MAX_FILE_NAME_LENGTH,
    details,
  );
  const mimeType = readMimeType(body.mimeType, details);
  const fileSize = readFileSize(body.fileSize, details);
  const capturedAt = readOptionalDate(body.capturedAt, 'capturedAt', details);
  const requestOcr = readOptionalBoolean(body.requestOcr, 'requestOcr', details);
  const ocrProvider = readOptionalText(
    body.ocrProvider,
    'ocrProvider',
    MAX_PROVIDER_LENGTH,
    details,
  );

  if (
    !photoType ||
    !fileReference ||
    !originalFileName ||
    !mimeType ||
    fileSize === undefined ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    photoType,
    fileReference,
    originalFileName,
    mimeType,
    fileSize,
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(requestOcr === undefined ? {} : { requestOcr }),
    ...(ocrProvider === undefined ? {} : { ocrProvider }),
  };
}

export function parseRecordVisitorPhotoOcrResultBody(
  body: unknown,
): RecordVisitorPhotoOcrResultInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const ocrStatus = body.ocrStatus;
  if (
    ocrStatus !== 'PENDING' &&
    ocrStatus !== 'PROCESSED' &&
    ocrStatus !== 'FAILED'
  ) {
    details.push({
      field: 'ocrStatus',
      message: 'ocrStatus must be one of: PENDING, PROCESSED, FAILED.',
    });
  }

  const ocrProvider = readOptionalText(
    body.ocrProvider,
    'ocrProvider',
    MAX_PROVIDER_LENGTH,
    details,
  );
  const ocrError = readOptionalText(
    body.ocrError,
    'ocrError',
    MAX_ERROR_LENGTH,
    details,
  );
  const ocrProcessedAt = readOptionalDate(
    body.ocrProcessedAt,
    'ocrProcessedAt',
    details,
  );
  const extractedFullName = readOptionalText(
    body.extractedFullName,
    'extractedFullName',
    MAX_NAME_LENGTH,
    details,
  );
  const extractedIdentityType = readExtractedIdentityType(
    body.extractedIdentityType,
    details,
  );
  const extractedIdentityNumber = readOptionalText(
    body.extractedIdentityNumber,
    'extractedIdentityNumber',
    MAX_IDENTITY_NUMBER_LENGTH,
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ocrStatus: ocrStatus as 'PENDING' | 'PROCESSED' | 'FAILED',
    ...(ocrProvider === undefined ? {} : { ocrProvider }),
    ...(ocrError === undefined ? {} : { ocrError }),
    ...(ocrProcessedAt === undefined ? {} : { ocrProcessedAt }),
    ...(extractedFullName === undefined ? {} : { extractedFullName }),
    ...(extractedIdentityType === undefined ? {} : { extractedIdentityType }),
    ...(extractedIdentityNumber === undefined
      ? {}
      : { extractedIdentityNumber }),
  };
}

export function parseReviewVisitorPhotoBody(
  body: unknown,
): ReviewVisitorPhotoInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const decision = body.decision;
  if (decision !== 'APPLY' && decision !== 'REJECT') {
    details.push({
      field: 'decision',
      message: 'decision must be APPLY or REJECT.',
    });
  }

  const applyFullName = readOptionalBoolean(
    body.applyFullName,
    'applyFullName',
    details,
  );
  const applyIdentity = readOptionalBoolean(
    body.applyIdentity,
    'applyIdentity',
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    decision: decision as 'APPLY' | 'REJECT',
    ...(applyFullName === undefined ? {} : { applyFullName }),
    ...(applyIdentity === undefined ? {} : { applyIdentity }),
  };
}

export function parseVisitorPhotoListQuery(
  query: Record<string, unknown>,
): VisitorPhotoListFilters {
  const details: ValidationDetail[] = [];

  const photoTypeRaw = readSingleParam(query.photoType);
  let photoType;
  if (
    photoTypeRaw !== undefined &&
    photoTypeRaw !== null &&
    photoTypeRaw !== ''
  ) {
    if (!isVisitorPhotoType(photoTypeRaw)) {
      details.push({
        field: 'photoType',
        message: `photoType must be one of: ${VISITOR_PHOTO_TYPES.join(', ')}.`,
      });
    } else {
      photoType = photoTypeRaw;
    }
  }

  const ocrStatusRaw = readSingleParam(query.ocrStatus);
  let ocrStatus;
  if (
    ocrStatusRaw !== undefined &&
    ocrStatusRaw !== null &&
    ocrStatusRaw !== ''
  ) {
    if (!isVisitorPhotoOcrStatus(ocrStatusRaw)) {
      details.push({
        field: 'ocrStatus',
        message: `ocrStatus must be one of: ${VISITOR_PHOTO_OCR_STATUSES.join(', ')}.`,
      });
    } else {
      ocrStatus = ocrStatusRaw;
    }
  }

  const reviewStatusRaw = readSingleParam(query.reviewStatus);
  let reviewStatus;
  if (
    reviewStatusRaw !== undefined &&
    reviewStatusRaw !== null &&
    reviewStatusRaw !== ''
  ) {
    if (!isVisitorPhotoReviewStatus(reviewStatusRaw)) {
      details.push({
        field: 'reviewStatus',
        message: `reviewStatus must be one of: ${VISITOR_PHOTO_REVIEW_STATUSES.join(', ')}.`,
      });
    } else {
      reviewStatus = reviewStatusRaw;
    }
  }

  const statusRaw = readSingleParam(query.status);
  let status;
  if (statusRaw !== undefined && statusRaw !== null && statusRaw !== '') {
    if (!isVisitorPhotoStatus(statusRaw)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${VISITOR_PHOTO_STATUSES.join(', ')}.`,
      });
    } else {
      status = statusRaw;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(photoType === undefined ? {} : { photoType }),
    ...(ocrStatus === undefined ? {} : { ocrStatus }),
    ...(reviewStatus === undefined ? {} : { reviewStatus }),
    ...(status === undefined ? {} : { status }),
  };
}

/* ------------------------------------------------------------------ */
/*  Field readers                                                      */
/* ------------------------------------------------------------------ */

function readSingleParam(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function readPhotoType(value: unknown, details: ValidationDetail[]) {
  if (!isVisitorPhotoType(value)) {
    details.push({
      field: 'photoType',
      message: `photoType must be one of: ${VISITOR_PHOTO_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readExtractedIdentityType(
  value: unknown,
  details: ValidationDetail[],
): VisitorIdentityType | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (!isVisitorIdentityType(value)) {
    details.push({
      field: 'extractedIdentityType',
      message: `extractedIdentityType must be one of: ${VISITOR_IDENTITY_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readMimeType(
  value: unknown,
  details: ValidationDetail[],
): string | undefined {
  const parsed = readRequiredText(value, 'mimeType', MAX_MIME_LENGTH, details);
  if (!parsed) {
    return undefined;
  }
  if (!IMAGE_MIME_PATTERN.test(parsed)) {
    details.push({
      field: 'mimeType',
      message: 'mimeType must be an image MIME type (image/*).',
    });
    return undefined;
  }
  return parsed.toLowerCase();
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
      message: `fileSize must be an integer between 0 and ${MAX_FILE_SIZE} bytes.`,
    });
    return undefined;
  }
  return value;
}

function readOptionalBoolean(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    details.push({ field, message: `${field} must be a boolean.` });
    return undefined;
  }
  return value;
}

function readRequiredText(
  value: unknown,
  field: string,
  max: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalText(
  value: unknown,
  field: string,
  max: number,
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
  if (trimmed.length > max) {
    details.push({
      field,
      message: `${field} must be at most ${max} characters.`,
    });
    return undefined;
  }
  return trimmed;
}

function readOptionalDate(
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
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    details.push({ field, message: `${field} must be an ISO date string.` });
    return undefined;
  }
  return parsed.toISOString();
}

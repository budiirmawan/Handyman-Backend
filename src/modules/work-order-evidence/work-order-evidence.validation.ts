import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isWorkOrderEvidenceType,
  WORK_ORDER_EVIDENCE_TYPES,
  type SubmitWorkOrderEvidenceInput,
  type WorkOrderEvidenceType,
} from './work-order-evidence.types';

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

export function parseWorkOrderIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'workOrderId',
        message: 'Work order id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseEvidenceIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'evidenceId',
        message: 'Evidence id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseSubmitEvidenceBody(
  body: unknown,
): Omit<SubmitWorkOrderEvidenceInput, 'workOrderId' | 'clientId' | 'submittedByUserId'> {
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
      : readOptionalUuid(body.evidenceRequirementId, 'evidenceRequirementId', details);
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
  const capturedAt = readOptionalString(
    body.capturedAt,
    'capturedAt',
    64,
    details,
  );

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
    ...(evidenceRequirementId === undefined
      ? {}
      : { evidenceRequirementId }),
    fileReference,
    originalFileName,
    mimeType,
    fileSize,
    ...(capturedAt === undefined ? {} : { capturedAt }),
  };
}

function readEvidenceType(
  value: unknown,
  details: ValidationDetail[],
): WorkOrderEvidenceType | undefined {
  if (!isWorkOrderEvidenceType(value)) {
    details.push({
      field: 'evidenceType',
      message: `Evidence type must be one of: ${WORK_ORDER_EVIDENCE_TYPES.join(', ')}.`,
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

function readOptionalUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field} must be a valid UUID.`,
    });
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

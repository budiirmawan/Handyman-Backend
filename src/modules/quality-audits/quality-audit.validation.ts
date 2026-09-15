import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  QUALITY_AUDIT_RESULTS,
  QUALITY_AUDIT_SOURCE_TYPES,
  QUALITY_AUDIT_STATUSES,
  isQualityAuditResult,
  isQualityAuditSourceType,
  isQualityAuditStatus,
  type CompleteQualityAuditInput,
  type CreateQualityAuditInput,
  type QualityAuditFilter,
  type QualityAuditResult,
  type QualityAuditSourceType,
  type QualityAuditStatus,
  type UpdateQualityAuditInput,
} from './quality-audit.types';

const MAX_NOTES_LENGTH = 1000;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseQualityAuditIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Quality audit id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateQualityAuditBody(
  body: unknown,
): Omit<CreateQualityAuditInput, 'auditorUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let sourceType: QualityAuditSourceType | undefined;
  if (!isQualityAuditSourceType(body.sourceType)) {
    details.push({
      field: 'sourceType',
      message: `sourceType must be one of: ${QUALITY_AUDIT_SOURCE_TYPES.join(', ')}.`,
    });
  } else {
    sourceType = body.sourceType;
  }

  const sourceId = readRequiredUuid(body.sourceId, 'sourceId', details);

  let score: number | null | undefined;
  if (body.score !== undefined && body.score !== null) {
    if (typeof body.score !== 'number' || body.score < 0 || body.score > 100) {
      details.push({
        field: 'score',
        message: 'score must be a number between 0 and 100.',
      });
    } else {
      score = body.score;
    }
  }

  let result: QualityAuditResult | null | undefined;
  if (body.result !== undefined && body.result !== null) {
    if (!isQualityAuditResult(body.result)) {
      details.push({
        field: 'result',
        message: `result must be one of: ${QUALITY_AUDIT_RESULTS.join(', ')}.`,
      });
    } else {
      result = body.result;
    }
  }

  const notes = readOptionalString(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!sourceType || !sourceId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    sourceType,
    sourceId,
    ...(score !== undefined ? { score } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseUpdateQualityAuditBody(
  body: unknown,
): UpdateQualityAuditInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let score: number | null | undefined;
  if (body.score !== undefined && body.score !== null) {
    if (typeof body.score !== 'number' || body.score < 0 || body.score > 100) {
      details.push({
        field: 'score',
        message: 'score must be a number between 0 and 100.',
      });
    } else {
      score = body.score;
    }
  }

  let result: QualityAuditResult | null | undefined;
  if (body.result !== undefined && body.result !== null) {
    if (!isQualityAuditResult(body.result)) {
      details.push({
        field: 'result',
        message: `result must be one of: ${QUALITY_AUDIT_RESULTS.join(', ')}.`,
      });
    } else {
      result = body.result;
    }
  }

  const notes = readOptionalString(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(score !== undefined ? { score } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseCompleteQualityAuditBody(
  body: unknown,
): CompleteQualityAuditInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let result: QualityAuditResult | undefined;
  if (!isQualityAuditResult(body.result)) {
    details.push({
      field: 'result',
      message: `result must be one of: ${QUALITY_AUDIT_RESULTS.join(', ')}.`,
    });
  } else {
    result = body.result;
  }

  let score: number | null | undefined;
  if (body.score !== undefined && body.score !== null) {
    if (typeof body.score !== 'number' || body.score < 0 || body.score > 100) {
      details.push({
        field: 'score',
        message: 'score must be a number between 0 and 100.',
      });
    } else {
      score = body.score;
    }
  }

  const notes = readOptionalString(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!result || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    result,
    ...(score !== undefined ? { score } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseQualityAuditFilter(
  query: Record<string, unknown>,
): QualityAuditFilter {
  const details: ValidationDetail[] = [];

  const buildingId =
    query.buildingId === undefined
      ? undefined
      : readOptionalUuid(query.buildingId, 'buildingId', details);
  const cleaningAreaId =
    query.cleaningAreaId === undefined
      ? undefined
      : readOptionalUuid(query.cleaningAreaId, 'cleaningAreaId', details);

  let sourceType: QualityAuditSourceType | undefined;
  if (
    query.sourceType !== undefined &&
    query.sourceType !== null &&
    query.sourceType !== ''
  ) {
    if (!isQualityAuditSourceType(query.sourceType)) {
      details.push({
        field: 'sourceType',
        message: `sourceType must be one of: ${QUALITY_AUDIT_SOURCE_TYPES.join(', ')}.`,
      });
    } else {
      sourceType = query.sourceType;
    }
  }

  let result: QualityAuditResult | undefined;
  if (
    query.result !== undefined &&
    query.result !== null &&
    query.result !== ''
  ) {
    if (!isQualityAuditResult(query.result)) {
      details.push({
        field: 'result',
        message: `result must be one of: ${QUALITY_AUDIT_RESULTS.join(', ')}.`,
      });
    } else {
      result = query.result;
    }
  }

  let status: QualityAuditStatus | undefined;
  if (
    query.status !== undefined &&
    query.status !== null &&
    query.status !== ''
  ) {
    if (!isQualityAuditStatus(query.status)) {
      details.push({
        field: 'status',
        message: `status must be one of: ${QUALITY_AUDIT_STATUSES.join(', ')}.`,
      });
    } else {
      status = query.status;
    }
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId !== undefined && buildingId !== null ? { buildingId } : {}),
    ...(cleaningAreaId !== undefined && cleaningAreaId !== null
      ? { cleaningAreaId }
      : {}),
    ...(sourceType !== undefined ? { sourceType } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

function readRequiredUuid(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({ field, message: `${field} must be a valid UUID.` });
    return undefined;
  }
  return value.trim().toLowerCase();
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

function readOptionalString(
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

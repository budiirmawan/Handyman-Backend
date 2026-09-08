import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { isValidDateFormat } from '../daily-cleaning';
import {
  CONSUMABLE_REQUIREMENT_STATUSES,
  READINESS_STATUSES,
  isConsumableRequirementStatus,
  isReadinessStatus,
  type ConsumableReadinessFilter,
  type ConsumableRequirementFilter,
  type ConsumableRequirementStatus,
  type CreateConsumableRequirementInput,
  type ReadinessStatus,
  type RecordConsumableReadinessInput,
  type UpdateConsumableRequirementInput,
} from './consumable-readiness.types';

const CODE_PATTERN = /^[A-Z][A-Z0-9_-]*$/;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseConsumableRequirementIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Consumable requirement id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateConsumableRequirementBody(
  body: unknown,
): CreateConsumableRequirementInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const cleaningAreaId = readOptionalUuid(
    body.cleaningAreaId,
    'cleaningAreaId',
    details,
  );
  const code = readRequiredCode(body.code, 'code', details);
  const name = readRequiredString(body.name, 'name', 160, details);
  const unit = readRequiredString(body.unit, 'unit', 32, details);

  let requiredQuantity = 1;
  if (body.requiredQuantity !== undefined && body.requiredQuantity !== null) {
    if (
      typeof body.requiredQuantity !== 'number' ||
      body.requiredQuantity < 0
    ) {
      details.push({
        field: 'requiredQuantity',
        message: 'requiredQuantity must be a non-negative number.',
      });
    } else {
      requiredQuantity = body.requiredQuantity;
    }
  }

  const status = readRequirementStatus(body.status, details);

  if (
    !buildingId ||
    !code ||
    !name ||
    !unit ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    cleaningAreaId: cleaningAreaId ?? null,
    code,
    name,
    requiredQuantity,
    unit,
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseUpdateConsumableRequirementBody(
  body: unknown,
): UpdateConsumableRequirementInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const name =
    body.name === undefined
      ? undefined
      : readRequiredString(body.name, 'name', 160, details);
  const cleaningAreaId =
    body.cleaningAreaId === undefined
      ? undefined
      : readOptionalUuid(body.cleaningAreaId, 'cleaningAreaId', details);
  const unit =
    body.unit === undefined
      ? undefined
      : readRequiredString(body.unit, 'unit', 32, details);

  let requiredQuantity: number | undefined;
  if (body.requiredQuantity !== undefined && body.requiredQuantity !== null) {
    if (
      typeof body.requiredQuantity !== 'number' ||
      body.requiredQuantity < 0
    ) {
      details.push({
        field: 'requiredQuantity',
        message: 'requiredQuantity must be a non-negative number.',
      });
    } else {
      requiredQuantity = body.requiredQuantity;
    }
  }

  const status = readRequirementStatus(body.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(name !== undefined ? { name } : {}),
    ...(cleaningAreaId !== undefined ? { cleaningAreaId } : {}),
    ...(requiredQuantity !== undefined ? { requiredQuantity } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseRecordConsumableReadinessBody(
  body: unknown,
): Omit<RecordConsumableReadinessInput, 'requirementId' | 'checkedByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let readinessStatus: ReadinessStatus | undefined;
  if (!isReadinessStatus(body.readinessStatus)) {
    details.push({
      field: 'readinessStatus',
      message: `readinessStatus must be one of: ${READINESS_STATUSES.join(', ')}.`,
    });
  } else {
    readinessStatus = body.readinessStatus;
  }

  let availableQuantity: number | null = null;
  if (
    body.availableQuantity !== undefined &&
    body.availableQuantity !== null
  ) {
    if (
      typeof body.availableQuantity !== 'number' ||
      body.availableQuantity < 0
    ) {
      details.push({
        field: 'availableQuantity',
        message: 'availableQuantity must be a non-negative number.',
      });
    } else {
      availableQuantity = body.availableQuantity;
    }
  }

  let operationalDate: string | undefined;
  if (
    body.operationalDate !== undefined &&
    body.operationalDate !== null &&
    body.operationalDate !== ''
  ) {
    if (
      typeof body.operationalDate !== 'string' ||
      !isValidDateFormat(body.operationalDate.trim())
    ) {
      details.push({
        field: 'operationalDate',
        message: 'operationalDate must be a valid YYYY-MM-DD format.',
      });
    } else {
      operationalDate = body.operationalDate.trim();
    }
  }

  const notes =
    body.notes === undefined || body.notes === null
      ? null
      : String(body.notes).trim();

  if (!readinessStatus || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    readinessStatus,
    availableQuantity,
    ...(operationalDate !== undefined ? { operationalDate } : {}),
    notes,
  };
}

export function parseConsumableRequirementFilter(
  query: Record<string, unknown>,
): ConsumableRequirementFilter {
  const details: ValidationDetail[] = [];

  const buildingId =
    query.buildingId === undefined
      ? undefined
      : readOptionalUuid(query.buildingId, 'buildingId', details);
  const cleaningAreaId =
    query.cleaningAreaId === undefined
      ? undefined
      : readOptionalUuid(query.cleaningAreaId, 'cleaningAreaId', details);
  const status = readRequirementStatus(query.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId !== undefined && buildingId !== null ? { buildingId } : {}),
    ...(cleaningAreaId !== undefined && cleaningAreaId !== null
      ? { cleaningAreaId }
      : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseConsumableReadinessFilter(
  query: Record<string, unknown>,
): ConsumableReadinessFilter {
  const details: ValidationDetail[] = [];

  const buildingId =
    query.buildingId === undefined
      ? undefined
      : readOptionalUuid(query.buildingId, 'buildingId', details);
  const cleaningAreaId =
    query.cleaningAreaId === undefined
      ? undefined
      : readOptionalUuid(query.cleaningAreaId, 'cleaningAreaId', details);

  let readinessStatus: ReadinessStatus | undefined;
  if (
    query.readinessStatus !== undefined &&
    query.readinessStatus !== null &&
    query.readinessStatus !== ''
  ) {
    if (!isReadinessStatus(query.readinessStatus)) {
      details.push({
        field: 'readinessStatus',
        message: `readinessStatus must be one of: ${READINESS_STATUSES.join(', ')}.`,
      });
    } else {
      readinessStatus = query.readinessStatus;
    }
  }

  let date: string | undefined;
  if (query.date !== undefined && query.date !== null && query.date !== '') {
    if (
      typeof query.date !== 'string' ||
      !isValidDateFormat(query.date.trim())
    ) {
      details.push({
        field: 'date',
        message: 'date must be a valid YYYY-MM-DD format.',
      });
    } else {
      date = query.date.trim();
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
    ...(readinessStatus !== undefined ? { readinessStatus } : {}),
    ...(date !== undefined ? { date } : {}),
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

function readRequiredCode(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return undefined;
  }
  const normalized = value.trim().toUpperCase();
  if (
    normalized.length < 2 ||
    normalized.length > 64 ||
    !CODE_PATTERN.test(normalized)
  ) {
    details.push({
      field,
      message: `${field} must start with a letter and contain only uppercase letters, digits, hyphens, and underscores (2-64 characters).`,
    });
    return undefined;
  }
  return normalized;
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

function readRequirementStatus(
  value: unknown,
  details: ValidationDetail[],
): ConsumableRequirementStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isConsumableRequirementStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${CONSUMABLE_REQUIREMENT_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

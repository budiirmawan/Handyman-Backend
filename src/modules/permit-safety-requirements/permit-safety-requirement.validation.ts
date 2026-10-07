import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  isValidWorkType,
  normalizeWorkType,
} from '../work-orders/work-order.validation';
import {
  isValidRequestType,
  normalizeRequestType,
} from '../work-requests';
import {
  PERMIT_SAFETY_READINESS_STATUSES,
  isPermitSafetyReadinessStatus,
  type CreatePermitSafetyRequirementInput,
  type PermitSafetyReadinessStatus,
  type PermitSafetyRequirementFilters,
  type UpdatePermitSafetyReadinessInput,
} from './permit-safety-requirement.types';

type ValidationDetail = { field: string; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(details: ValidationDetail[]): never {
  throw AppError.validation('Request validation failed.', details);
}

export const parsePermitSafetyRequirementIdParam = (raw: string): string =>
  parseId(raw, 'safetyRequirementId');
export const parsePermitSafetyApplicationIdParam = (raw: string): string =>
  parseId(raw, 'permitApplicationId');
export const parsePermitSafetyPermitIdParam = (raw: string): string =>
  parseId(raw, 'permitId');

export function parseCreatePermitSafetyRequirementBody(
  body: unknown,
): CreatePermitSafetyRequirementInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const details: ValidationDetail[] = [];
  const buildingId = readId(body.buildingId, 'buildingId', true, details);
  const workType = readWorkType(body.workType, true, details);
  const requirementType = readRequirementType(
    body.requirementType,
    true,
    details,
  );
  const requirementDescription = readRequiredText(
    body.requirementDescription,
    'requirementDescription',
    2000,
    details,
  );
  const required = readRequiredFlag(body.required, details);
  const readinessStatus = readReadinessStatus(body.readinessStatus, details);
  const notes = readNullableText(body.notes, 'notes', 2000, details);
  const reference = readNullableText(body.reference, 'reference', 500, details);
  const checklistTemplateId = readNullableId(
    body.checklistTemplateId,
    'checklistTemplateId',
    details,
  );
  const checklistExecutionId = readNullableId(
    body.checklistExecutionId,
    'checklistExecutionId',
    details,
  );
  const evidenceRequirementId = readNullableId(
    body.evidenceRequirementId,
    'evidenceRequirementId',
    details,
  );
  if (
    !buildingId ||
    !workType ||
    !requirementType ||
    !requirementDescription ||
    details.length > 0
  ) {
    fail(details);
  }
  return {
    buildingId,
    workType,
    requirementType,
    requirementDescription,
    ...(required !== undefined ? { required } : {}),
    ...(readinessStatus ? { readinessStatus } : {}),
    ...(notes !== undefined ? { notes } : {}),
    ...(reference !== undefined ? { reference } : {}),
    ...(checklistTemplateId !== undefined ? { checklistTemplateId } : {}),
    ...(checklistExecutionId !== undefined ? { checklistExecutionId } : {}),
    ...(evidenceRequirementId !== undefined ? { evidenceRequirementId } : {}),
  };
}

export function parseUpdatePermitSafetyReadinessBody(
  body: unknown,
): UpdatePermitSafetyReadinessInput {
  if (!isRecord(body)) {
    fail([{ field: 'body', message: 'Request body must be a JSON object.' }]);
  }
  const immutable = [
    'permitId',
    'permitApplicationId',
    'buildingId',
    'workType',
    'requirementType',
    'requirementDescription',
    'required',
    'createdByUserId',
    'createdAt',
  ].find((field) => body[field] !== undefined);
  if (immutable) {
    fail([{ field: immutable, message: 'This Safety Requirement field is immutable.' }]);
  }
  const details: ValidationDetail[] = [];
  const readinessStatus = readReadinessStatus(body.readinessStatus, details);
  const notes = readNullableText(body.notes, 'notes', 2000, details);
  const reference = readNullableText(body.reference, 'reference', 500, details);
  const checklistTemplateId = readNullableId(
    body.checklistTemplateId,
    'checklistTemplateId',
    details,
  );
  const checklistExecutionId = readNullableId(
    body.checklistExecutionId,
    'checklistExecutionId',
    details,
  );
  const evidenceRequirementId = readNullableId(
    body.evidenceRequirementId,
    'evidenceRequirementId',
    details,
  );
  if (!readinessStatus) {
    details.push({
      field: 'readinessStatus',
      message: 'readinessStatus is required.',
    });
  }
  if (details.length > 0) fail(details);
  return {
    readinessStatus: readinessStatus as PermitSafetyReadinessStatus,
    ...(notes !== undefined ? { notes } : {}),
    ...(reference !== undefined ? { reference } : {}),
    ...(checklistTemplateId !== undefined ? { checklistTemplateId } : {}),
    ...(checklistExecutionId !== undefined ? { checklistExecutionId } : {}),
    ...(evidenceRequirementId !== undefined ? { evidenceRequirementId } : {}),
  };
}

export function parsePermitSafetyRequirementFilters(
  query: unknown,
): PermitSafetyRequirementFilters {
  if (!isRecord(query)) return {};
  const details: ValidationDetail[] = [];
  const permitId = readId(query.permitId, 'permitId', false, details);
  const permitApplicationId = readId(
    query.permitApplicationId,
    'permitApplicationId',
    false,
    details,
  );
  const buildingId = readId(query.buildingId, 'buildingId', false, details);
  const workType = readWorkType(query.workType, false, details);
  const readinessStatus = readReadinessStatus(
    query.readinessStatus ?? query.status,
    details,
  );
  if (details.length > 0) fail(details);
  return {
    ...(permitId ? { permitId } : {}),
    ...(permitApplicationId ? { permitApplicationId } : {}),
    ...(buildingId ? { buildingId } : {}),
    ...(workType ? { workType } : {}),
    ...(readinessStatus ? { readinessStatus } : {}),
  };
}

function parseId(raw: string, field: string): string {
  const value = raw.trim().toLowerCase();
  if (!isValidUuid(value)) {
    fail([{ field, message: `${field} must be a valid UUID.` }]);
  }
  return value;
}

function readId(
  value: unknown,
  field: string,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !isValidUuid(value.trim())) {
    details.push({
      field,
      message: `${field}${required ? ' is required and' : ''} must be a valid UUID.`,
    });
    return undefined;
  }
  return value.trim().toLowerCase();
}

function readNullableId(
  value: unknown,
  field: string,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readId(value, field, true, details);
}

function readWorkType(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') {
    details.push({ field: 'workType', message: 'workType is required.' });
    return undefined;
  }
  const normalized = normalizeWorkType(value);
  if (!isValidWorkType(normalized)) {
    details.push({
      field: 'workType',
      message: 'workType must be a valid controlled data code.',
    });
    return undefined;
  }
  return normalized;
}

function readRequirementType(
  value: unknown,
  required: boolean,
  details: ValidationDetail[],
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') {
    details.push({
      field: 'requirementType',
      message: 'requirementType is required.',
    });
    return undefined;
  }
  const normalized = normalizeRequestType(value);
  if (!isValidRequestType(normalized)) {
    details.push({
      field: 'requirementType',
      message: 'requirementType must be a valid data-driven code.',
    });
    return undefined;
  }
  return normalized;
}

function readReadinessStatus(
  value: unknown,
  details: ValidationDetail[],
): PermitSafetyReadinessStatus | undefined {
  if (value === undefined) return undefined;
  const normalized = typeof value === 'string'
    ? value.trim().toUpperCase()
    : value;
  if (!isPermitSafetyReadinessStatus(normalized)) {
    details.push({
      field: 'readinessStatus',
      message: `readinessStatus must be one of: ${PERMIT_SAFETY_READINESS_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return normalized;
}

function readRequiredFlag(
  value: unknown,
  details: ValidationDetail[],
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    details.push({ field: 'required', message: 'required must be a boolean.' });
    return undefined;
  }
  return value;
}

function readRequiredText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    details.push({ field, message: `${field} must be a non-empty string.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length > maxLength) {
    details.push({ field, message: `${field} is too long.` });
    return undefined;
  }
  return result;
}

function readNullableText(
  value: unknown,
  field: string,
  maxLength: number,
  details: ValidationDetail[],
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} must be a string or null.` });
    return undefined;
  }
  const result = value.trim();
  if (result.length === 0) return null;
  if (result.length > maxLength) {
    details.push({ field, message: `${field} is too long.` });
    return undefined;
  }
  return result;
}

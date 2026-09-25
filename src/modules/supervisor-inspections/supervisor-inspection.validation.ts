import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SUPERVISOR_INSPECTION_DECISIONS,
  SUPERVISOR_INSPECTION_STATUSES,
  SUPERVISOR_INSPECTION_TARGET_TYPES,
  isSupervisorInspectionDecision,
  isSupervisorInspectionStatus,
  isSupervisorInspectionTargetType,
  type CreateSupervisorInspectionInput,
  type SubmitSupervisorDecisionInput,
  type SupervisorInspectionDecision,
  type SupervisorInspectionFilter,
  type SupervisorInspectionStatus,
  type SupervisorInspectionTargetType,
} from './supervisor-inspection.types';

const MAX_NOTES_LENGTH = 1000;

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSupervisorInspectionIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'id',
        message: 'Supervisor inspection id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

/**
 * CR-BE-RN14-CLEANING-SUPERVISOR-MOBILE-01 — path parameter of the
 * target-scoped Daily Cleaning read. Validated as a UUID because it is the
 * Daily Cleaning identity (`generated_tasks.id`), not a supervisor
 * inspection id.
 */
export function parseDailyCleaningTaskIdParam(raw: string): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'taskId',
        message: 'Daily cleaning task id must be a valid UUID.',
      },
    ]);
  }
  return value.toLowerCase();
}

export function parseCreateSupervisorInspectionBody(
  body: unknown,
): Omit<CreateSupervisorInspectionInput, 'supervisorUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let targetType: SupervisorInspectionTargetType | undefined;
  if (!isSupervisorInspectionTargetType(body.targetType)) {
    details.push({
      field: 'targetType',
      message: `targetType must be one of: ${SUPERVISOR_INSPECTION_TARGET_TYPES.join(', ')}.`,
    });
  } else {
    targetType = body.targetType;
  }

  const targetId = readRequiredUuid(body.targetId, 'targetId', details);
  const notes = readOptionalString(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!targetType || !targetId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    targetType,
    targetId,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseSubmitSupervisorDecisionBody(
  body: unknown,
): SubmitSupervisorDecisionInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  let decision: SupervisorInspectionDecision | undefined;
  if (!isSupervisorInspectionDecision(body.decision)) {
    details.push({
      field: 'decision',
      message: `decision must be one of: ${SUPERVISOR_INSPECTION_DECISIONS.join(', ')}.`,
    });
  } else {
    decision = body.decision;
  }

  const notes = readOptionalString(
    body.notes,
    'notes',
    MAX_NOTES_LENGTH,
    details,
  );

  if (!decision || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    decision,
    ...(notes !== undefined ? { notes } : {}),
  };
}

export function parseSupervisorInspectionFilter(
  query: Record<string, unknown>,
): SupervisorInspectionFilter {
  const details: ValidationDetail[] = [];

  const status =
    query.status === undefined
      ? undefined
      : readStatus(query.status, details);
  const targetType =
    query.targetType === undefined
      ? undefined
      : readTargetType(query.targetType, details);
  const buildingId =
    query.buildingId === undefined
      ? undefined
      : readOptionalUuid(query.buildingId, 'buildingId', details);
  const cleaningAreaId =
    query.cleaningAreaId === undefined
      ? undefined
      : readOptionalUuid(query.cleaningAreaId, 'cleaningAreaId', details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(status !== undefined ? { status } : {}),
    ...(targetType !== undefined ? { targetType } : {}),
    ...(buildingId !== undefined && buildingId !== null ? { buildingId } : {}),
    ...(cleaningAreaId !== undefined && cleaningAreaId !== null
      ? { cleaningAreaId }
      : {}),
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): SupervisorInspectionStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isSupervisorInspectionStatus(value)) {
    details.push({
      field: 'status',
      message: `Status must be one of: ${SUPERVISOR_INSPECTION_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

function readTargetType(
  value: unknown,
  details: ValidationDetail[],
): SupervisorInspectionTargetType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isSupervisorInspectionTargetType(value)) {
    details.push({
      field: 'targetType',
      message: `Target type must be one of: ${SUPERVISOR_INSPECTION_TARGET_TYPES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

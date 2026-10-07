import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  PATROL_CHECKLIST_BINDING_STATUSES,
  isPatrolChecklistBindingStatus,
  type CreatePatrolChecklistBindingInput,
  type PatrolChecklistBindingFilter,
  type PatrolChecklistBindingStatus,
  type UpdatePatrolChecklistBindingInput,
} from './patrol-checklist-binding.types';

export type ValidationDetail = {
  field: string;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseUuidParam(
  raw: string,
  field: string,
  label: string,
): string {
  const value = raw.trim();
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${label} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseBindingIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Patrol checklist binding id');
}

export function parseExecutionIdParam(raw: string): string {
  return parseUuidParam(
    raw,
    'id',
    'Patrol checklist execution id',
  );
}

export function parseCreatePatrolChecklistBindingBody(
  body: unknown,
): Omit<CreatePatrolChecklistBindingInput, 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const buildingId = readRequiredUuid(body.buildingId, 'buildingId', details);
  const patrolRouteId = readRequiredUuid(
    body.patrolRouteId,
    'patrolRouteId',
    details,
  );
  const checklistTemplateId = readRequiredUuid(
    body.checklistTemplateId,
    'checklistTemplateId',
    details,
  );
  const startSecurityPostId = readOptionalNullableUuid(
    body.startSecurityPostId,
    'startSecurityPostId',
    details,
  );
  const status = readStatus(body.status, details);

  if (
    !buildingId ||
    !patrolRouteId ||
    !checklistTemplateId ||
    details.length > 0
  ) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    buildingId,
    patrolRouteId,
    checklistTemplateId,
    ...(startSecurityPostId !== undefined ? { startSecurityPostId } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseUpdatePatrolChecklistBindingBody(
  body: unknown,
): UpdatePatrolChecklistBindingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdatePatrolChecklistBindingInput = {};

  const startSecurityPostId = readOptionalNullableUuid(
    body.startSecurityPostId,
    'startSecurityPostId',
    details,
  );
  if (startSecurityPostId !== undefined) {
    input.startSecurityPostId = startSecurityPostId;
  }

  const status = readStatus(body.status, details);
  if (status !== undefined) {
    input.status = status;
  }

  if (Object.keys(input).length === 0) {
    details.push({
      field: 'body',
      message: 'At least one updatable field is required.',
    });
  }

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return input;
}

export function parsePatrolChecklistBindingFilter(
  query: Record<string, unknown>,
): PatrolChecklistBindingFilter {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(
    query.buildingId,
    'buildingId',
    details,
  );
  const patrolRouteId = readOptionalUuid(
    query.patrolRouteId,
    'patrolRouteId',
    details,
  );
  const checklistTemplateId = readOptionalUuid(
    query.checklistTemplateId,
    'checklistTemplateId',
    details,
  );
  const status = readStatus(query.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId !== undefined ? { buildingId } : {}),
    ...(patrolRouteId !== undefined ? { patrolRouteId } : {}),
    ...(checklistTemplateId !== undefined ? { checklistTemplateId } : {}),
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

function readOptionalNullableUuid(
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

function readStatus(
  value: unknown,
  details: ValidationDetail[],
): PatrolChecklistBindingStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isPatrolChecklistBindingStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${PATROL_CHECKLIST_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

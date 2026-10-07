import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  SECURITY_SHIFT_HANDOVER_BINDING_STATUSES,
  isSecurityShiftHandoverBindingStatus,
  type CreateSecurityShiftHandoverBindingInput,
  type SecurityShiftHandoverBindingFilter,
  type SecurityShiftHandoverBindingStatus,
  type UpdateSecurityShiftHandoverBindingInput,
} from './security-shift-handover.types';

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

export function parseBuildingIdParam(raw: string): string {
  return parseUuidParam(raw, 'buildingId', 'Building id');
}

export function parseBindingIdParam(raw: string): string {
  return parseUuidParam(raw, 'id', 'Security shift handover binding id');
}

export function parseCreateSecurityShiftHandoverBindingBody(
  body: unknown,
): Omit<CreateSecurityShiftHandoverBindingInput, 'buildingId' | 'createdByUserId'> {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];

  const shiftHandoverId = readRequiredUuid(
    body.shiftHandoverId,
    'shiftHandoverId',
    details,
  );
  const startSecurityPostId = readOptionalNullableUuid(
    body.startSecurityPostId,
    'startSecurityPostId',
    details,
  );
  const patrolRouteId = readOptionalNullableUuid(
    body.patrolRouteId,
    'patrolRouteId',
    details,
  );
  const status = readStatus(body.status, details);

  if (!shiftHandoverId || details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    shiftHandoverId,
    ...(startSecurityPostId !== undefined ? { startSecurityPostId } : {}),
    ...(patrolRouteId !== undefined ? { patrolRouteId } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

export function parseUpdateSecurityShiftHandoverBindingBody(
  body: unknown,
): UpdateSecurityShiftHandoverBindingInput {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }

  const details: ValidationDetail[] = [];
  const input: UpdateSecurityShiftHandoverBindingInput = {};

  const startSecurityPostId = readOptionalNullableUuid(
    body.startSecurityPostId,
    'startSecurityPostId',
    details,
  );
  if (startSecurityPostId !== undefined) {
    input.startSecurityPostId = startSecurityPostId;
  }

  const patrolRouteId = readOptionalNullableUuid(
    body.patrolRouteId,
    'patrolRouteId',
    details,
  );
  if (patrolRouteId !== undefined) {
    input.patrolRouteId = patrolRouteId;
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

export function parseSecurityShiftHandoverBindingFilter(
  query: Record<string, unknown>,
): SecurityShiftHandoverBindingFilter {
  const details: ValidationDetail[] = [];

  const buildingId = readOptionalUuid(
    query.buildingId,
    'buildingId',
    details,
  );
  const shiftHandoverId = readOptionalUuid(
    query.shiftHandoverId,
    'shiftHandoverId',
    details,
  );
  const startSecurityPostId = readOptionalUuid(
    query.startSecurityPostId,
    'startSecurityPostId',
    details,
  );
  const patrolRouteId = readOptionalUuid(
    query.patrolRouteId,
    'patrolRouteId',
    details,
  );
  const status = readStatus(query.status, details);

  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }

  return {
    ...(buildingId !== undefined ? { buildingId } : {}),
    ...(shiftHandoverId !== undefined ? { shiftHandoverId } : {}),
    ...(startSecurityPostId !== undefined ? { startSecurityPostId } : {}),
    ...(patrolRouteId !== undefined ? { patrolRouteId } : {}),
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
): SecurityShiftHandoverBindingStatus | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isSecurityShiftHandoverBindingStatus(value)) {
    details.push({
      field: 'status',
      message: `status must be one of: ${SECURITY_SHIFT_HANDOVER_BINDING_STATUSES.join(', ')}.`,
    });
    return undefined;
  }
  return value;
}

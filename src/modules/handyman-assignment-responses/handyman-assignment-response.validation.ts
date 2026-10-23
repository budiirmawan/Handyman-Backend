import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  handymanAssignmentDeclineReasonRequiredError,
  handymanAssignmentResponseDeadlineInvalidError,
} from './handyman-assignment-response.errors';
import {
  MAX_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES,
  MIN_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES,
} from './handyman-assignment-response.types';

const FORBIDDEN_SMUGGLED_FIELDS = [
  'respondedAt',
  'occurredAt',
  'actorUserId',
  'respondedByUserId',
  'clientId',
  'buildingId',
  'status',
  'responseStatus',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectSmuggledFields(body: Record<string, unknown>): void {
  const details: Array<{ field: string; message: string }> = [];
  for (const field of FORBIDDEN_SMUGGLED_FIELDS) {
    if (body[field] !== undefined) {
      details.push({
        field,
        message: `${field} is server-derived and must not be supplied by the caller.`,
      });
    }
  }
  if (details.length > 0) {
    throw AppError.validation('Request validation failed.', details);
  }
}

export function parseUuidParam(raw: unknown, field: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export function parseAcknowledgeAssignmentBody(body: unknown): {
  assignmentId?: string;
  notes?: string;
  idempotencyKey?: string;
} {
  if (body === undefined || body === null) {
    return {};
  }
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  rejectSmuggledFields(body);

  let assignmentId: string | undefined;
  if (body.assignmentId !== undefined && body.assignmentId !== null) {
    if (typeof body.assignmentId !== 'string' || !isValidUuid(body.assignmentId.trim())) {
      throw AppError.validation('Request validation failed.', [
        { field: 'assignmentId', message: 'assignmentId must be a valid UUID.' },
      ]);
    }
    assignmentId = body.assignmentId.trim().toLowerCase();
  }

  if (body.responseCode !== undefined && body.responseCode !== 'TERIMA') {
    throw AppError.validation('Request validation failed.', [
      { field: 'responseCode', message: 'responseCode on acknowledge must be TERIMA when provided.' },
    ]);
  }

  let notes: string | undefined;
  if (body.notes !== undefined && body.notes !== null) {
    if (typeof body.notes !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'notes', message: 'notes must be a string.' },
      ]);
    }
    const trimmed = body.notes.trim();
    if (trimmed.length > 1000) {
      throw AppError.validation('Request validation failed.', [
        { field: 'notes', message: 'notes must be at most 1000 characters.' },
      ]);
    }
    if (trimmed.length > 0) notes = trimmed;
  }

  let idempotencyKey: string | undefined;
  if (body.idempotencyKey !== undefined && body.idempotencyKey !== null) {
    if (typeof body.idempotencyKey !== 'string') {
      throw AppError.validation('Request validation failed.', [
        { field: 'idempotencyKey', message: 'idempotencyKey must be a string.' },
      ]);
    }
    const trimmed = body.idempotencyKey.trim();
    if (trimmed.length < 1 || trimmed.length > 200) {
      throw AppError.validation('Request validation failed.', [
        { field: 'idempotencyKey', message: 'idempotencyKey must be 1..200 characters.' },
      ]);
    }
    idempotencyKey = trimmed;
  }

  return { assignmentId, notes, idempotencyKey };
}

export function parseDeclineAssignmentBody(body: unknown): {
  assignmentId?: string;
  reason: string;
  notes?: string;
  idempotencyKey?: string;
} {
  if (!isRecord(body)) {
    throw handymanAssignmentDeclineReasonRequiredError();
  }
  rejectSmuggledFields(body);

  if (body.responseCode !== undefined && body.responseCode !== 'TIDAK_BISA') {
    throw AppError.validation('Request validation failed.', [
      { field: 'responseCode', message: 'responseCode on decline must be TIDAK_BISA when provided.' },
    ]);
  }

  if (typeof body.reason !== 'string') {
    throw handymanAssignmentDeclineReasonRequiredError();
  }
  const reason = body.reason.trim();
  if (reason.length < 1 || reason.length > 1000) {
    throw handymanAssignmentDeclineReasonRequiredError();
  }

  const optional = parseAcknowledgeAssignmentBody({
    assignmentId: body.assignmentId,
    notes: body.notes,
    idempotencyKey: body.idempotencyKey,
  });

  return {
    ...optional,
    reason,
  };
}

export function parseDeadlinePolicyQuery(query: unknown): {
  clientId: string;
  buildingId: string | null;
} {
  if (!isRecord(query)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'clientId query parameter is required.' },
    ]);
  }
  const clientId =
    typeof query.clientId === 'string' ? query.clientId.trim().toLowerCase() : '';
  if (!isValidUuid(clientId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  let buildingId: string | null = null;
  if (
    query.buildingId !== undefined &&
    query.buildingId !== null &&
    query.buildingId !== ''
  ) {
    const rawBuilding =
      typeof query.buildingId === 'string'
        ? query.buildingId.trim().toLowerCase()
        : '';
    if (!isValidUuid(rawBuilding)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'buildingId', message: 'buildingId must be a valid UUID.' },
      ]);
    }
    buildingId = rawBuilding;
  }
  return { clientId, buildingId };
}

export function parseUpsertDeadlinePolicyBody(body: unknown): {
  clientId: string;
  buildingId: string | null;
  deadlineMinutes: number;
} {
  if (!isRecord(body)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'body', message: 'Request body must be a JSON object.' },
    ]);
  }
  const clientId =
    typeof body.clientId === 'string' ? body.clientId.trim().toLowerCase() : '';
  if (!isValidUuid(clientId)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'clientId', message: 'clientId must be a valid UUID.' },
    ]);
  }
  let buildingId: string | null = null;
  if (
    body.buildingId !== undefined &&
    body.buildingId !== null &&
    body.buildingId !== ''
  ) {
    const rawBuilding =
      typeof body.buildingId === 'string'
        ? body.buildingId.trim().toLowerCase()
        : '';
    if (!isValidUuid(rawBuilding)) {
      throw AppError.validation('Request validation failed.', [
        { field: 'buildingId', message: 'buildingId must be a valid UUID.' },
      ]);
    }
    buildingId = rawBuilding;
  }

  if (body.autoReassignEnabled === true) {
    throw handymanAssignmentResponseDeadlineInvalidError(
      'Automatic reassignment (autoReassignEnabled: true) is forbidden without explicit business rules; overdue assignments require Operations action.',
    );
  }

  const deadlineMinutes = body.deadlineMinutes;
  if (
    typeof deadlineMinutes !== 'number' ||
    !Number.isInteger(deadlineMinutes) ||
    deadlineMinutes < MIN_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES ||
    deadlineMinutes > MAX_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES
  ) {
    throw handymanAssignmentResponseDeadlineInvalidError(
      `deadlineMinutes must be an integer between ${MIN_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES} and ${MAX_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES}.`,
    );
  }

  return { clientId, buildingId, deadlineMinutes };
}

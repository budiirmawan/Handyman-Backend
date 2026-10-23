import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function fail(message: string, details: { field: string; message: string }[]) {
  throw AppError.validation(message, details);
}

function uuid(value: unknown, field: string): string {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isValidUuid(raw)) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return raw;
}

function reason(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length < 1 || raw.length > 1000) {
    fail('Request validation failed.', [
      { field: 'reason', message: 'reason is required (1-1000 characters).' },
    ]);
  }
  return raw;
}

function version(value: unknown, field = 'expectedVersion'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a positive integer.` },
    ]);
  }
  return value as number;
}

export function parseVisitIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(p(value), 'visitAppointmentId');
}

export function parseAssignmentIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(p(value), 'assignmentId');
}

export function parseRespondInspectorBody(body: unknown): {
  responseStatus: 'TERIMA' | 'TIDAK_BISA';
  declineReason?: string | null;
  notes?: string | null;
} {
  const src = (body ?? {}) as Record<string, unknown>;
  const rawDecision =
    typeof src.responseStatus === 'string'
      ? src.responseStatus.trim()
      : typeof src.decision === 'string'
        ? src.decision.trim()
        : '';
  if (rawDecision !== 'TERIMA' && rawDecision !== 'TIDAK_BISA') {
    fail("responseStatus/decision must be either 'TERIMA' or 'TIDAK_BISA'.", [
      {
        field: 'responseStatus',
        message: "responseStatus must be either 'TERIMA' or 'TIDAK_BISA'.",
      },
    ]);
  }
  const rawDeclineReason =
    src.declineReason !== undefined && src.declineReason !== null
      ? src.declineReason
      : src.reason;
  const declineReason =
    rawDeclineReason === undefined || rawDeclineReason === null
      ? null
      : typeof rawDeclineReason === 'string'
        ? rawDeclineReason
        : '';
  const notes =
    src.notes === undefined || src.notes === null
      ? null
      : typeof src.notes === 'string'
        ? src.notes
        : '';
  return {
    responseStatus: rawDecision as 'TERIMA' | 'TIDAK_BISA',
    declineReason,
    notes,
  };
}

export function parseRequestIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(p(value), 'handymanRequestId');
}

export function parseAssignInspectorBody(body: unknown): {
  inspectorUserId: string;
} {
  const src = (body ?? {}) as Record<string, unknown>;
  return {
    inspectorUserId: uuid(src.inspectorUserId, 'inspectorUserId'),
  };
}

export function parseReassignInspectorBody(body: unknown): {
  inspectorUserId: string;
  expectedVersion: number;
  reason: string;
  idempotencyKey?: string;
} {
  const src = (body ?? {}) as Record<string, unknown>;
  const keyRaw =
    typeof src.idempotencyKey === 'string'
      ? src.idempotencyKey.trim()
      : undefined;
  if (keyRaw !== undefined && (keyRaw.length < 8 || keyRaw.length > 128)) {
    fail('Request validation failed.', [
      {
        field: 'idempotencyKey',
        message: 'idempotencyKey must be 8-128 characters when supplied.',
      },
    ]);
  }
  return {
    inspectorUserId: uuid(src.inspectorUserId, 'inspectorUserId'),
    expectedVersion: version(src.expectedVersion),
    reason: reason(src.reason),
    idempotencyKey: keyRaw,
  };
}

export function parseRevokeInspectorBody(body: unknown): {
  expectedVersion: number;
  reason: string;
} {
  const src = (body ?? {}) as Record<string, unknown>;
  return {
    expectedVersion: version(src.expectedVersion),
    reason: reason(src.reason),
  };
}

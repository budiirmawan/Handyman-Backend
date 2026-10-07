import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type { HandymanWorkSessionStartWorkInput }
  from '../handyman-work-sessions';

/**
 * CR-HM-08 PART 05 — work-session HTTP input validation. Whitelist
 * parsers ONLY: callers may submit exactly `{ idempotencyKey }`;
 * executionScopeId comes from the URL. EVERYTHING else —
 * actorUserId/workerId/crewId/assignmentId/helper list/timestamps/
 * arrivalResultId/status override — is structurally ignored (never
 * spread, never forwarded into the PART 02–04 services).
 */

const first = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function fail(
  message: string,
  details: { field: string; message: string }[],
): never {
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

export function parseWorkSessionScopeParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'executionScopeId');
}

export function parseWorkSessionIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'sessionId');
}

/**
 * Mutation body: EXACTLY idempotencyKey (required, bounded length).
 * Unknown keys (including authority-shaped ones) are ignored — the
 * caller can never steer actor/crew/assignment/timestamps/status.
 */
export function parseWorkSessionMutationBody(
  body: unknown,
): HandymanWorkSessionStartWorkInput {
  const source = (body ?? {}) as Record<string, unknown>;
  const raw = typeof source.idempotencyKey === 'string'
    ? source.idempotencyKey.trim()
    : '';
  if (raw.length === 0) {
    fail('Request validation failed.', [
      { field: 'idempotencyKey',
        message: 'idempotencyKey is required.' },
    ]);
  }
  if (raw.length > 200) {
    fail('Request validation failed.', [
      { field: 'idempotencyKey',
        message: 'idempotencyKey must not exceed 200 characters.' },
    ]);
  }
  // Positional/bounded: the parsed shape is rebuilt from scratch —
  // scope binding arrives from the URL at the controller boundary.
  return { executionScopeId: '', idempotencyKey: raw };
}

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

/**
 * CR-HM-04 activation PART C — assignment HTTP input validation.
 * Whitelist parsers ONLY: callers may submit exactly
 * `{providerContextId, crewId}`. Everything else — clientId, status,
 * leadWorkerId, leadUserId, assignedAt, supersedesAssignmentId, any
 * scheduling/arrival/QR/geofence/work-session/FM field — is
 * structurally ignored (never spread, never forwarded).
 */

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

export function parseAssignmentScopeParam(
  value: string | string[] | undefined,
): string {
  return uuid(p(value), 'executionScopeId');
}

/** Caller-established references ONLY; scope id comes from the URL. */
export function parseAssignmentBody(body: unknown): {
  providerContextId: string;
  crewId: string;
} {
  const src = (body ?? {}) as Record<string, unknown>;
  return {
    providerContextId: uuid(src.providerContextId, 'providerContextId'),
    crewId: uuid(src.crewId, 'crewId'),
  };
}

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

export function parseScopeParam(value: string | string[] | undefined): string {
  return uuid(p(value), 'executionScopeId');
}

export function parseRequestParam(value: string | string[] | undefined): string {
  return uuid(p(value), 'handymanRequestId');
}

export function parseReleaseBody(body: unknown): {
  appointmentId?: string;
} {
  const src = (body ?? {}) as Record<string, unknown>;
  if (src.appointmentId === undefined || src.appointmentId === null) return {};
  return { appointmentId: uuid(src.appointmentId, 'appointmentId') };
}

export function parseCancelBody(body: unknown): { reason: string } {
  const src = (body ?? {}) as Record<string, unknown>;
  const reason = typeof src.reason === 'string' ? src.reason.trim() : '';
  if (reason.length < 1 || reason.length > 1000) {
    fail('Request validation failed.', [
      { field: 'reason', message: 'reason is required (1-1000 characters).' },
    ]);
  }
  return { reason };
}

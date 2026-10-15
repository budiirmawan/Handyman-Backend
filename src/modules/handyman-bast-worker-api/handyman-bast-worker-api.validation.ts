import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';

/**
 * CR-HM-BAST-HTTP-01 — bounded whitelist validation for the worker BAST
 * transport. The actor identity ALWAYS comes from the authenticated session
 * (`req.auth`); no body field may name an actor, client, building, crew or
 * provider. Unknown body fields are ignored, never forwarded to services.
 */

function fail(field: string, message: string): never {
  throw AppError.validation('Request validation failed.', [
    { field, message },
  ]);
}

function ensureObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('body', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

function parseId(raw: string, field: string): string {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!isValidUuid(trimmed)) {
    fail(field, `${field} must be a valid UUID.`);
  }
  return trimmed;
}

export function parseWorkerBastScopeParam(raw: string): string {
  return parseId(raw, 'executionScopeId');
}

export function parseWorkerBastIdParam(raw: string): string {
  return parseId(raw, 'bastId');
}

function parseIdempotencyKey(obj: Record<string, unknown>): string {
  const rawKey = typeof obj.idempotencyKey === 'string'
    ? obj.idempotencyKey.trim()
    : '';
  if (rawKey.length === 0 || rawKey.length > 200) {
    fail(
      'idempotencyKey',
      'idempotencyKey is required and must be 1..200 characters.',
    );
  }
  return rawKey;
}

function parseExpectedVersion(
  obj: Record<string, unknown>,
): number | null {
  if (obj.expectedVersion === undefined || obj.expectedVersion === null) {
    return null;
  }
  const raw = obj.expectedVersion;
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(num) || num < 1) {
    fail('expectedVersion', 'expectedVersion must be a positive integer.');
  }
  return num;
}

export type ParsedWorkerBastPrepareBody = {
  idempotencyKey: string;
};

export function parseWorkerBastPrepareBody(
  body: unknown,
): ParsedWorkerBastPrepareBody {
  const obj = ensureObject(body);
  return { idempotencyKey: parseIdempotencyKey(obj) };
}

export type ParsedWorkerBastTransitionBody = {
  idempotencyKey: string;
  expectedVersion: number | null;
};

export function parseWorkerBastIssueBody(
  body: unknown,
): ParsedWorkerBastTransitionBody {
  const obj = ensureObject(body);
  return {
    idempotencyKey: parseIdempotencyKey(obj),
    expectedVersion: parseExpectedVersion(obj),
  };
}

export type ParsedWorkerBastVoidBody = ParsedWorkerBastTransitionBody & {
  reason: string;
};

/**
 * The worker VOID transport REQUIRES a non-empty justification (1..2000
 * chars) — it is preserved in the append-only event chain
 * (`event.metadata.voidReason`) alongside the historical records. This is
 * transport policy; in-process service callers may still void without one.
 */
export function parseWorkerBastVoidBody(
  body: unknown,
): ParsedWorkerBastVoidBody {
  const obj = ensureObject(body);
  const rawReason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  if (rawReason.length === 0 || rawReason.length > 2000) {
    fail('reason', 'reason is required and must be 1..2000 characters.');
  }
  return {
    idempotencyKey: parseIdempotencyKey(obj),
    expectedVersion: parseExpectedVersion(obj),
    reason: rawReason,
  };
}

import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import type {
  EstimateHandymanMaterialLineInput,
} from '../handyman-material-execution';

/**
 * CR-HM-09 PART 06 — material-execution HTTP input validation.
 * Whitelist parsers ONLY: bounded scalar fields, rebuilt from
 * scratch; executionScopeId and lineId arrive from the URL. EVERY
 * authority-shaped field — actorUserId / quotation authority beyond
 * the bounded arguments / timestamps / status / mode — is
 * structurally IGNORED (never spread, never forwarded). Quantity
 * numbers are finite positive numbers checked at this boundary as
 * FINITE only (exact legal bounds are the PART 03–05 services'
 * authority). ZERO pricing/billing/payment fields can exist on any
 * request shape.
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

function key(value: unknown, field = 'idempotencyKey'): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) {
    fail('Request validation failed.', [
      { field, message: 'idempotencyKey is required.' },
    ]);
  }
  if (raw.length > 200) {
    fail('Request validation failed.', [
      { field, message: 'idempotencyKey must not exceed 200 characters.' },
    ]);
  }
  return raw;
}

function quantity(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) {
    fail('Request validation failed.', [
      { field, message: `${field} must be a finite number.` },
    ]);
  }
  return n;
}

function text(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0) return null;
  if (raw.length > 200) {
    fail('Request validation failed.', [
      { field, message: `${field} must not exceed 200 characters.` },
    ]);
  }
  return raw;
}

export function parseMaterialScopeParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'executionScopeId');
}

export function parseMaterialLineIdParam(
  value: string | string[] | undefined,
): string {
  return uuid(first(value), 'lineId');
}

/** Bounded body for estimate-keyed mutations (ESTIMATE only). */
export function parseEstimateBody(
  body: unknown,
): Omit<EstimateHandymanMaterialLineInput, 'executionScopeId'> {
  const source = (body ?? {}) as Record<string, unknown>;
  const quotationVersionId = uuid(source.quotationVersionId,
    'quotationVersionId');
  const quotationLineId = uuid(source.quotationLineId,
    'quotationLineId');
  const estimatedQty = quantity(source.estimatedQty, 'estimatedQty');
  const idempotencyKey = key(source.idempotencyKey);
  return {
    quotationVersionId,
    quotationLineId,
    estimatedQty,
    idempotencyKey,
  };
}

/** Bounded body for { idempotencyKey } mutations (APPROVE/SETTLE). */
export function parseKeyBody(
  body: unknown,
): Pick<EstimateHandymanMaterialLineInput, 'idempotencyKey'> {
  const source = (body ?? {}) as Record<string, unknown>;
  return { idempotencyKey: key(source.idempotencyKey) };
}

/** Bounded body for quantity mutations (ISSUE/PURCHASE/USE/RETURN). */
export function parseQuantityBody(
  body: unknown,
): { quantity: number; supplierReference: string | null;
  idempotencyKey: string } {
  const source = (body ?? {}) as Record<string, unknown>;
  return {
    quantity: quantity(source.quantity, 'quantity'),
    supplierReference: text(source.supplierReference,
      'supplierReference'),
    idempotencyKey: key(source.idempotencyKey),
  };
}

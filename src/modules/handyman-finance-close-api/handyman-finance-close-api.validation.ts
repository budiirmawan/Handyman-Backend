import { AppError } from '../../shared/errors';

/**
 * CR-HM-E2E-LIFECYCLE-01 — strict transport validation for the
 * finance close HTTP seams (J10–J12).
 *
 * Bodies are plain objects with an explicit allow-list per endpoint.
 * Any other key (clientId, actor, amount authority, status, timestamps,
 * …) is rejected at the transport edge instead of being silently
 * ignored, so no frontend-derived business authority can be smuggled
 * into the domain services. Domain validation of values themselves
 * (UUID shape, canonical decimals, idempotency keys, transitions)
 * stays in the owning services.
 */

export function requirePlainBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw AppError.validation('Request body must be a JSON object.');
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw AppError.validation('Request body must be a plain JSON object.');
  }
  return value as Record<string, unknown>;
}

export function assertOnlyKeys(
  body: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw AppError.validation(
      `Unknown request fields: ${unknown.sort().join(', ')}.`,
    );
  }
}

export function requireStringField(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw AppError.validation(`${field} must be a non-empty string.`);
  }
  return value;
}

export function optionalNullableStringField(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const value = body[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw AppError.validation(`${field} must be a string or null.`);
  }
  return value;
}

export function requireIdempotencyKey(body: Record<string, unknown>): string {
  return requireStringField(body, 'idempotencyKey');
}

export function requireQueryString(
  query: Record<string, unknown>,
  field: string,
): string {
  const value = query[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw AppError.validation(`${field} query parameter is required.`);
  }
  return value;
}

export function optionalQueryString(
  query: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = query[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw AppError.validation(`${field} query parameter is invalid.`);
  }
  return value;
}

export function optionalQueryLimit(
  query: Record<string, unknown>,
): number | undefined {
  const value = query.limit;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw AppError.validation('limit query parameter must be an integer.');
  }
  return Number(value.trim());
}

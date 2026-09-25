import { AppError, ERROR_CODES } from '../../shared/errors';

/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — Idempotency-Key parser.
 *
 * Exact convention:
 * - trim surrounding whitespace
 * - required variant
 * - reject: empty, CR, LF, NUL
 * - max raw length: 200
 * - Do NOT store raw key, return normalized key suitable for hashing.
 *
 * Missing/blank required key → 400 IDEMPOTENCY_KEY_REQUIRED
 * Malformed/oversized → generic validation-error convention (400 VALIDATION_ERROR)
 *
 * Raw key must NOT appear in database, logs, errors, audit metadata.
 */

export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

function idempotencyKeyRequiredError(): AppError {
  return new AppError({
    code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
    message: 'Idempotency-Key is required.',
    statusCode: 400,
  });
}

function validationError(details: { field: string; message: string }[]): AppError {
  return AppError.validation('Request validation failed.', details);
}

/**
 * Parses a required Idempotency-Key header value.
 * Returns normalized (trimmed) key suitable for hashing.
 */
export function parseIdempotencyKeyRequired(
  rawValue: string | undefined,
): string {
  if (rawValue === undefined || rawValue === null) {
    throw idempotencyKeyRequiredError();
  }

  const raw = rawValue;
  if (raw.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw validationError([
      {
        field: 'Idempotency-Key',
        message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      },
    ]);
  }

  // Check for CR, LF, NUL in raw value before trimming — interior characters
  // must be rejected even if surrounding whitespace is trimmed.
  if (/[\r\n\0]/.test(raw)) {
    throw validationError([
      {
        field: 'Idempotency-Key',
        message: 'Idempotency-Key contains invalid characters.',
      },
    ]);
  }

  const normalized = raw.trim();
  if (!normalized) {
    throw idempotencyKeyRequiredError();
  }

  if (normalized.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw validationError([
      {
        field: 'Idempotency-Key',
        message: `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
      },
    ]);
  }

  if (/[\r\n\0]/.test(normalized)) {
    throw validationError([
      {
        field: 'Idempotency-Key',
        message: 'Idempotency-Key contains invalid characters.',
      },
    ]);
  }

  return normalized;
}

/**
 * Optional variant — returns undefined when missing, otherwise same validation.
 * Useful for endpoints where key is not yet required, but kept for symmetry.
 */
export function parseIdempotencyKeyOptional(
  rawValue: string | undefined,
): string | undefined {
  if (rawValue === undefined) return undefined;
  return parseIdempotencyKeyRequired(rawValue);
}

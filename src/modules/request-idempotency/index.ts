/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — generic request idempotency foundation.
 *
 * Bounded module: src/modules/request-idempotency/
 *
 * Provides:
 * - transaction-owning service: executeIdempotent({ actorUserId, operationKey, idempotencyKey, requestFingerprint, work })
 * - repository: tryClaim, findByIdentity, complete (Executor/PoolClient explicit)
 * - validation: parseIdempotencyKeyRequired (trim, reject CR/LF/NUL, max 200, 400 IDEMPOTENCY_KEY_REQUIRED)
 * - crypto: sha256Hex, stableJson via shared helpers
 * - error vocabulary: IDEMPOTENCY_KEY_REQUIRED, IDEMPOTENCY_CONFLICT
 *
 * Security:
 * - Raw Idempotency-Key never appears in DB, logs, errors, audit metadata.
 * - Actor scoping prevents cross-user replay.
 * - Operation scoping prevents cross-command replay.
 *
 * Retention cleanup is separate infrastructure governance; correctness does
 * not depend on deletion.
 */

export * from './request-idempotency.types';
export { requestIdempotencyRepository } from './request-idempotency.repository';
export {
  executeIdempotent,
  computeRequestFingerprint,
  MAX_RESPONSE_BYTES,
  requestIdempotencyService,
} from './request-idempotency.service';
export {
  parseIdempotencyKeyRequired,
  parseIdempotencyKeyOptional,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from './request-idempotency.validation';
export {
  idempotencyKeyRequiredError,
  idempotencyConflictError,
} from './request-idempotency.errors';

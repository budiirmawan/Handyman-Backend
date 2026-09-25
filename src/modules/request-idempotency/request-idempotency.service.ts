import { withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { sha256Hex } from '../../shared/hash';
import { stableJson } from '../../shared/stable-json';
import { idempotencyConflictError } from './request-idempotency.errors';
import { requestIdempotencyRepository } from './request-idempotency.repository';
import type {
  ExecuteIdempotentInput,
  ExecuteIdempotentResult,
} from './request-idempotency.types';

/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — transaction-owning generic service.
 *
 * Generic identity:
 *   actorUserId + server-defined operationKey + SHA-256(normalized Idempotency-Key)
 *
 * Request equivalence:
 *   SHA-256(stable canonical JSON request fingerprint)
 *
 * Required behavior:
 * - same actor + operation + key + fingerprint → one mutation, replay returns stored success
 * - same actor + operation + key + DIFFERENT fingerprint → 409 IDEMPOTENCY_CONFLICT
 * - different actor → independent namespace
 * - different operation → independent namespace
 * - business rollback → idempotency claim also rolls back (single transaction)
 * - 5xx/domain failure → no completed/poisoned record remains
 * - Do NOT store failures.
 *
 * Concurrency:
 * - Rely on PostgreSQL unique-index conflict waiting.
 * - Do NOT poll, sleep/retry at infrastructure level, commit IN_PROGRESS separately,
 *   or use advisory locks.
 * - Concurrent identical requests → one work execution, one persisted success, one replay.
 * - If owner transaction rolls back, waiting contender may become owner and execute once.
 *
 * Response storage:
 * - Generic store contains HTTP success status + canonical JSON success data,
 *   not a domain DTO type.
 * - Limit serialized response body to 65536 bytes (UTF-8). If exceeded, FAIL LOUDLY,
 *   rollback entire transaction, leave no idempotency record. No truncation.
 *
 * Security:
 * - Raw Idempotency-Key must NOT appear in database, logs, errors, audit metadata.
 * - Conflict may expose generic code and operationKey if convention permits,
 *   but NOT stored response, fingerprint, or raw key.
 *
 * Retention cleanup is separate infrastructure governance; correctness does
 * not depend on deletion.
 */

export const MAX_RESPONSE_BYTES = 65536;

function assertValidFingerprint(fingerprint: string): void {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'requestFingerprint',
        message: 'requestFingerprint must be a 64-char lowercase SHA-256 hex.',
      },
    ]);
  }
}

function assertSuccessStatus(status: number): void {
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    throw new AppError({
      code: 'BAD_REQUEST' as any,
      message: 'Idempotent work must return a 2xx success status.',
      statusCode: 500,
    });
  }
}

/**
 * Transaction-owning idempotent execution.
 *
 * The high-level generic service OWNS the transaction — endpoint callers
 * do NOT assemble transaction manually. This is necessary for PART 02
 * unsafe-report retries.
 *
 * Algorithm within ONE withTransaction:
 * A. hash normalized key
 * B. try INSERT claim status=IN_PROGRESS ON CONFLICT DO NOTHING RETURNING
 * C1. CLAIM OWNED → run work(client), validate success, store COMPLETED in SAME transaction, commit, return replayed=false
 * C2. CLAIM NOT OWNED → read existing by identity, compare fingerprint, throw 409 if different, else return stored COMPLETED, replayed=true
 */
export async function executeIdempotent(
  input: ExecuteIdempotentInput,
): Promise<ExecuteIdempotentResult> {
  assertValidFingerprint(input.requestFingerprint);
  if (!input.actorUserId || !input.operationKey || !input.idempotencyKey) {
    throw AppError.validation('Request validation failed.', [
      { field: 'idempotency', message: 'actorUserId, operationKey, and idempotencyKey are required.' },
    ]);
  }

  const idempotencyKeyHash = sha256Hex(input.idempotencyKey);

  return withTransaction(async (client) => {
    const claimed = await requestIdempotencyRepository.tryClaim(
      {
        actorUserId: input.actorUserId,
        operationKey: input.operationKey,
        idempotencyKeyHash,
        requestFingerprint: input.requestFingerprint,
      },
      client,
    );

    if (claimed) {
      // CLAIM OWNED — execute business mutation using SAME transaction client
      let workResult: { responseStatus: number; responseBody: unknown };
      try {
        workResult = await input.work(client);
      } catch (error) {
        // Store SUCCESS ONLY — rollback claim + business mutation, no record remains
        // Rethrow to trigger withTransaction ROLLBACK
        throw error;
      }

      assertSuccessStatus(workResult.responseStatus);

      // Validate response body size — UTF-8 serialized byte length, not char count
      // Use stableJson for canonical serialization (deterministic)
      const serialized = stableJson(workResult.responseBody);
      const byteLength = Buffer.byteLength(serialized, 'utf8');
      if (byteLength > MAX_RESPONSE_BYTES) {
        throw new AppError({
          code: 'BAD_REQUEST' as any,
          message: `Response body exceeds ${MAX_RESPONSE_BYTES} bytes (${byteLength}).`,
          statusCode: 500,
        });
      }

      const completed = await requestIdempotencyRepository.complete(
        {
          id: claimed.id,
          responseStatus: workResult.responseStatus,
          responseBody: workResult.responseBody,
        },
        client,
      );

      if (!completed) {
        throw new AppError({
          code: 'INTERNAL_SERVER_ERROR' as any,
          message: 'Failed to complete idempotency record.',
          statusCode: 500,
        });
      }

      return {
        responseStatus: completed.responseStatus!,
        responseBody: completed.responseBody,
        replayed: false,
      };
    }

    // CLAIM NOT OWNED — read existing record by exact identity
    const existing = await requestIdempotencyRepository.findByIdentity(
      input.actorUserId,
      input.operationKey,
      idempotencyKeyHash,
      client,
    );

    if (!existing) {
      // This should be rare: the conflicting row was inserted by a concurrent
      // transaction that rolled back after we waited on the unique index.
      // In that case our earlier INSERT waited, then succeeded? Actually
      // PostgreSQL would allow our INSERT to succeed after rollback, so we
      // would have been in the CLAIM OWNED path. If we reach here with no row,
      // it means another transaction committed deletion? But we have no deletion
      // in PART 01. Treat as retryable internal state — throw to rollback and
      // let caller retry, but for determinism we attempt one more claim?
      // Simpler: throw conflict or internal? For safety, we throw a generic
      // error that will rollback and not poison.
      throw new AppError({
        code: 'INTERNAL_SERVER_ERROR' as any,
        message: 'Idempotency claim not found after conflict.',
        statusCode: 500,
      });
    }

    // Compare request_fingerprint — if different, throw 409 IDEMPOTENCY_CONFLICT
    // Do NOT expose stored response.
    if (existing.requestFingerprint !== input.requestFingerprint) {
      throw idempotencyConflictError(input.operationKey);
    }

    // Require committed record is COMPLETED — atomic design ensures external
    // caller never observes independently committed IN_PROGRESS.
    if (existing.status !== 'COMPLETED') {
      throw new AppError({
        code: 'INTERNAL_SERVER_ERROR' as any,
        message: 'Idempotency record not completed.',
        statusCode: 500,
      });
    }

    if (
      existing.responseStatus === null ||
      existing.responseStatus < 200 ||
      existing.responseStatus > 299 ||
      existing.responseBody === null
    ) {
      throw new AppError({
        code: 'INTERNAL_SERVER_ERROR' as any,
        message: 'Idempotency record has invalid completed state.',
        statusCode: 500,
      });
    }

    return {
      responseStatus: existing.responseStatus,
      responseBody: existing.responseBody,
      replayed: true,
    };
  });
}

/**
 * Helper to compute request fingerprint from a canonical JSON value.
 * Uses stableJson + sha256Hex — caller must have normalized semantic values.
 */
export function computeRequestFingerprint(value: unknown): string {
  return sha256Hex(stableJson(value));
}

export const requestIdempotencyService = {
  executeIdempotent,
  computeRequestFingerprint,
};

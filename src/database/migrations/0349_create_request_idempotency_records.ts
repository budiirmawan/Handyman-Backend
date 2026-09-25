import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-IDEMPOTENCY-CORE-01 PART 01 — Generic request idempotency foundation.
 *
 * Generic table: request_idempotency_records
 *
 * Identity: actor_user_id + operation_key + SHA-256(normalized Idempotency-Key)
 * Equivalence: SHA-256(stable canonical JSON request fingerprint)
 *
 * Behavior:
 * - same actor + operation + key + fingerprint → one mutation, replay returns stored success
 * - same identity + different fingerprint → 409 IDEMPOTENCY_CONFLICT
 * - different actor → independent namespace
 * - different operation → independent namespace
 * - business rollback → idempotency claim also rolls back (single transaction)
 * - 5xx/domain failure → no completed/poisoned record remains
 *
 * Retention cleanup is separate infrastructure governance; correctness does
 * not depend on deletion.
 */
export const migration0349CreateRequestIdempotencyRecords: Migration = {
  id: '0349_create_request_idempotency_records',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE request_idempotency_records (
        id UUID PRIMARY KEY,
        actor_user_id UUID NOT NULL REFERENCES users(id),
        operation_key TEXT NOT NULL,
        idempotency_key_hash TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL,
        response_status SMALLINT NULL,
        response_body JSONB NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ NULL,
        CONSTRAINT request_idempotency_records_idempotency_key_hash_format_check
          CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
        CONSTRAINT request_idempotency_records_request_fingerprint_format_check
          CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
        CONSTRAINT request_idempotency_records_status_check
          CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
        CONSTRAINT request_idempotency_records_in_progress_check
          CHECK (
            status != 'IN_PROGRESS' OR (
              response_status IS NULL
              AND response_body IS NULL
              AND completed_at IS NULL
            )
          ),
        CONSTRAINT request_idempotency_records_completed_check
          CHECK (
            status != 'COMPLETED' OR (
              response_status BETWEEN 200 AND 299
              AND response_body IS NOT NULL
              AND completed_at IS NOT NULL
            )
          ),
        CONSTRAINT request_idempotency_records_actor_operation_key_unique
          UNIQUE (actor_user_id, operation_key, idempotency_key_hash)
      )
    `);

    await client.query(`
      CREATE INDEX request_idempotency_records_created_at_idx
        ON request_idempotency_records (created_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS request_idempotency_records
    `);
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-25H — Mobile sync idempotency store.
 *
 * Makes mobile retry/sync operations safe against duplicate execution:
 *
 *   - `operation_id` is the client-generated operation identifier
 *     (BE-25G contract) and is UNIQUE per `user_id`, so a retried batch
 *     cannot execute the same write twice.
 *   - `resource_type` / `resource_id` / `operation` bind the key to the
 *     request/resource, so a replay of the SAME operation returns the
 *     stored result.
 *   - `status` records the outcome (SUCCESS / FAILED) and
 *     `result`/`error_code`/`error_message` store the processing
 *     result/reference for the safe replay response.
 *   - `processed_at` is the server timestamp of the original execution.
 *
 * The store is per-user (a user's operation ids never collide with another
 * user's) and deliberately contains no business data beyond the replay
 * payload. Conflict handling (BE-25I) is not part of this contract.
 */
export const migration0234CreateMobileSyncIdempotency: Migration = {
  id: '0234_create_mobile_sync_idempotency',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE mobile_sync_idempotency (
        id              UUID PRIMARY KEY,
        user_id         UUID NOT NULL REFERENCES users (id),
        operation_id    TEXT NOT NULL,
        resource_type   TEXT NOT NULL,
        resource_id     UUID NOT NULL,
        operation       TEXT NOT NULL,
        status          TEXT NOT NULL,
        result          JSONB,
        error_code      TEXT,
        error_message   TEXT,
        client_timestamp TEXT NOT NULL,
        processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT mobile_sync_idempotency_user_operation_unique
          UNIQUE (user_id, operation_id),
        CONSTRAINT mobile_sync_idempotency_status_check
          CHECK (status IN ('SUCCESS', 'FAILED'))
      )
    `);

    await client.query(`
      CREATE INDEX mobile_sync_idempotency_user_resource_idx
        ON mobile_sync_idempotency (user_id, resource_type, resource_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS mobile_sync_idempotency');
  },
};

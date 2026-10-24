import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FIELD-OPS-ACK-01 PART 01 — concurrent-device assignment response keys.
 *
 * Additive ONLY. The canonical response ledger from 0472 is unchanged; a
 * nullable, caller-supplied key column is added next to the existing internal
 * `idempotency_key` (which stays the deterministic per-assignment event key).
 *
 * Invariants:
 *   1. A client key (8..128 chars, trimmed) may only exist on a FINALIZED
 *      response (`TERIMA` / `TIDAK_BISA`) — never on `PENDING`.
 *   2. One actor may use one client key for exactly ONE assignment. A replay
 *      of the same key against a DIFFERENT assignment (e.g. an offline device
 *      retrying after Operations reassigned the job) cannot silently finalize
 *      the new worker's assignment. It is rejected with 409.
 *   3. Legacy rows keep `NULL`, so an in-place upgrade never has to deduplicate
 *      historical data and the index is always safe to create.
 *
 * No arrival-challenge, notification-engine, scheduling or deployment change.
 */
export const migration0476HandymanAssignmentResponseClientKeys: Migration = {
  id: '0476_handyman_assignment_response_client_keys',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_assignment_responses
        ADD COLUMN IF NOT EXISTS client_idempotency_key TEXT
    `);

    await client.query(`
      ALTER TABLE handyman_assignment_responses
        DROP CONSTRAINT IF EXISTS hm_assign_resp_client_key_check
    `);
    await client.query(`
      ALTER TABLE handyman_assignment_responses
        ADD CONSTRAINT hm_assign_resp_client_key_check CHECK (
          client_idempotency_key IS NULL
          OR (
            responded_by_user_id IS NOT NULL
            AND response_status IN ('TERIMA', 'TIDAK_BISA')
            AND length(btrim(client_idempotency_key)) BETWEEN 8 AND 128
          )
        )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS hm_assign_resp_client_key_uniq
        ON handyman_assignment_responses
          (responded_by_user_id, client_idempotency_key)
        WHERE client_idempotency_key IS NOT NULL
          AND responded_by_user_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS hm_assign_resp_client_key_uniq
    `);
    await client.query(`
      ALTER TABLE handyman_assignment_responses
        DROP CONSTRAINT IF EXISTS hm_assign_resp_client_key_check
    `);
    await client.query(`
      ALTER TABLE handyman_assignment_responses
        DROP COLUMN IF EXISTS client_idempotency_key
    `);
  },
};

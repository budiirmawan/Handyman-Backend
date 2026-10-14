import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-OPS-DISPATCH-02 P0-B — Harden execution-scope reassignment.
 *
 * Adds concurrency version, reassignment reason, and an append-only history
 * table used by the service to persist every supersession event with actor,
 * timestamp, reason and idempotency key. The original assignment table keeps
 * its existing PART A immutability trigger intact; additional metadata is
 * persisted here instead.
 */
export const migration0439HardenExecutionScopeReassignment: Migration = {
  id: '0439_harden_execution_scope_reassignment',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE handyman_execution_scope_assignments
        ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1
          CHECK (version > 0);

      CREATE TABLE handyman_execution_scope_assignment_history (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients(id),
        assignment_id               UUID NOT NULL
          REFERENCES handyman_execution_scope_assignments(id),
        execution_scope_id          UUID NOT NULL,
        from_provider_context_id    UUID,
        from_crew_id                UUID,
        to_provider_context_id      UUID NOT NULL,
        to_crew_id                  UUID NOT NULL,
        action                      TEXT NOT NULL
          CHECK (action IN ('ASSIGNED', 'REASSIGNED', 'REVOKED')),
        reason                      TEXT,
        expected_version            INTEGER,
        prior_version               INTEGER,
        actor_user_id               UUID NOT NULL REFERENCES users(id),
        idempotency_key             TEXT
          CHECK (idempotency_key IS NULL OR char_length(btrim(idempotency_key)) BETWEEN 8 AND 128),
        occurred_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_es_assignment_history_reason_check
          CHECK (action = 'ASSIGNED' OR char_length(btrim(reason)) BETWEEN 1 AND 1000)
      );

      CREATE UNIQUE INDEX handyman_es_assignment_history_idempotency_idx
        ON handyman_execution_scope_assignment_history
          (client_id, execution_scope_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      CREATE INDEX handyman_es_assignment_history_scope_idx
        ON handyman_execution_scope_assignment_history
          (client_id, execution_scope_id, occurred_at DESC);
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TABLE IF EXISTS handyman_execution_scope_assignment_history;
      ALTER TABLE handyman_execution_scope_assignments
        DROP COLUMN IF EXISTS version;
    `);
  },
};

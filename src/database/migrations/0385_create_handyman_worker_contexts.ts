import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-04 PART 02 — Handyman Worker Context (FROZEN F2/F5/F8/F9/F10).
 *
 * Additive minimum (one new bounded table; reverting `down`; ZERO changes
 * to `workforce_profiles`, `vendor_workforce_bindings`, or any other
 * existing table).
 *
 *   handyman_worker_contexts   Handyman-owned association establishing
 *   that a workforce profile MAY participate under one Handyman provider
 *   context (F2). It duplicates NO person identity (`workforce_profiles`
 *   remains the master; `userId` may stay NULL — helpers need no login,
 *   F5) and links NO crew/role/session semantics. One context per
 *   (provider-context, profile) pair; lifecycle ACTIVE ⇄ INACTIVE (F8);
 *   history lives in the append-only journal authority (F10). Rows are
 *   never hard-deleted.
 */
export const migration0385CreateHandymanWorkerContexts: Migration = {
  id: '0385_create_handyman_worker_contexts',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_worker_contexts (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        handyman_provider_context_id UUID NOT NULL
          REFERENCES handyman_provider_contexts (id),
        workforce_profile_id        UUID NOT NULL
          REFERENCES workforce_profiles (id),
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id          UUID NOT NULL REFERENCES users (id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_worker_contexts_pair_unique
          UNIQUE (handyman_provider_context_id, workforce_profile_id),
        CONSTRAINT handyman_worker_contexts_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_worker_contexts_scope_idx
        ON handyman_worker_contexts (client_id, created_at)
    `);
    await client.query(`
      CREATE INDEX handyman_worker_contexts_provider_idx
        ON handyman_worker_contexts
        (handyman_provider_context_id, workforce_profile_id)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_worker_contexts CASCADE');
  },
};

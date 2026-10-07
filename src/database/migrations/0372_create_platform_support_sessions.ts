import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 11 — Support Access Core (frozen §19.1).
 *
 * `platform_support_sessions` carries the canonical explicit support
 * grant: a Gatepro platform actor (`support_actor_user_id`) obtains
 * time-bound, single-customer, optionally-single-building visibility
 * into a target tenant context. Status is derived-on-read
 * (`ACTIVE` / `ENDED`) so expiry is effective without a cleanup job.
 *
 * - No impersonation, ever (§19.2 rule 3): the session does not replace
 *   any tenant user's identity.
 * - "Unique effective session per (support_actor_user_id, customer_id)"
 *   (§19.1) is NOT enforced by a partial unique index because the
 *   effective predicate is time-dependent (`status='ACTIVE' AND
 *   expires_at > NOW()`) and Postgres partial indexes cannot reference
 *   `NOW()`. The same-row invariant is enforced by an advisory
 *   transaction lock + read-check-insert inside `withTransaction`
 *   (see `platform-support-session.service.ts`). Expired sessions
 *   whose row remains `status='ACTIVE'` (storage) are intentionally
 *   allowed to coexist with a new session — the storage row is
 *   considered "ineffective" at read time and does not block.
 * - No secrets stored. `reason` is mandatory TEXT at the schema layer
 *   so omission is a SQL-level constraint.
 * - `expires_at` is server-authoritative; client-supplied expiry is
 *   bounded via `durationMinutes` (§19.2 rule 1).
 */
export const migration0372CreatePlatformSupportSessions: Migration = {
  id: '0372_create_platform_support_sessions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE platform_support_sessions (
        id UUID PRIMARY KEY,
        support_actor_user_id UUID NOT NULL,
        customer_id UUID NOT NULL,
        building_id UUID,
        reason TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        ended_by_user_id UUID,
        status TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK (status IN ('ACTIVE', 'ENDED')),
        CONSTRAINT platform_support_sessions_actor_fkey
          FOREIGN KEY (support_actor_user_id) REFERENCES users (id),
        CONSTRAINT platform_support_sessions_customer_fkey
          FOREIGN KEY (customer_id) REFERENCES clients (id),
        CONSTRAINT platform_support_sessions_reason_nonempty_check
          CHECK (length(btrim(reason)) > 0),
        CONSTRAINT platform_support_sessions_expiry_after_start_check
          CHECK (expires_at > started_at)
      )
    `);

    // Indexes — narrow lookups by actor and by customer for `GET
    // /platform/support-sessions` filterable listing. Keep building
    // scope filter cheap.
    await client.query(
      `CREATE INDEX platform_support_sessions_actor_idx
        ON platform_support_sessions (support_actor_user_id)`,
    );
    await client.query(
      `CREATE INDEX platform_support_sessions_customer_idx
        ON platform_support_sessions (customer_id)`,
    );
    await client.query(
      `CREATE INDEX platform_support_sessions_expires_at_idx
        ON platform_support_sessions (expires_at)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS platform_support_sessions');
  },
};

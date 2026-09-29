import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-04 PART 03 — Handyman Work Crew + Membership + Lead (FROZEN
 * F3/F4/F5/F8/F9/F10).
 *
 * Additive minimum (new bounded tables only; reverting `down`; ZERO
 * changes to `teams`, `workforce_profiles`, `vendors`, or any other
 * existing table. `teams` is NOT reused — it is department org naming,
 * not the Handyman operational grouping (F3).
 *
 *   handyman_work_crews       crew under exactly ONE Handyman provider
 *     context. Latency: ACTIVE ⇄ INACTIVE only (F8) — creation is
 *     TRANSACTIONAL with the initial Lead member, so an ACTIVE crew can
 *     never exist lead-less (no DRAFT status is invented).
 *
 *   handyman_crew_memberships membership binds an existing Handyman
 *     Worker Context (F2) — helpers welcome (`userId` NULL allowed); one
 *     ACTIVE membership per (crew, worker context) via partial UNIQUE
 *     (BE-03 window idiom); status lifecycle only; rows never deleted.
 *
 *   handyman_crew_leads       APPEND-ONLY lead designation history
 *     (F4/F10). `lead_seq BIGSERIAL` supplies deterministic ordering —
 *     current lead = MAX(lead_seq) for the crew; previous designations
 *     stay historical. Triggers refuse UPDATE/DELETE.
 */
export const migration0386CreateHandymanWorkCrews: Migration = {
  id: '0386_create_handyman_work_crews',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_work_crews (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        handyman_provider_context_id UUID NOT NULL
          REFERENCES handyman_provider_contexts (id),
        code                        TEXT NOT NULL,
        name                        TEXT NOT NULL,
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id          UUID NOT NULL REFERENCES users (id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_work_crews_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT handyman_work_crews_code_unique
          UNIQUE (handyman_provider_context_id, code),
        CONSTRAINT handyman_work_crews_code_length_check
          CHECK (char_length(code) BETWEEN 1 AND 64),
        CONSTRAINT handyman_work_crews_name_length_check
          CHECK (char_length(name) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_work_crews_scope_idx
        ON handyman_work_crews (client_id, created_at)
    `);

    await client.query(`
      CREATE TABLE handyman_crew_memberships (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        handyman_crew_id            UUID NOT NULL
          REFERENCES handyman_work_crews (id),
        handyman_worker_context_id  UUID NOT NULL
          REFERENCES handyman_worker_contexts (id),
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id          UUID NOT NULL REFERENCES users (id),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_crew_memberships_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_crew_memberships_active_unique
        ON handyman_crew_memberships (handyman_crew_id, handyman_worker_context_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(`
      CREATE INDEX handyman_crew_memberships_scope_idx
        ON handyman_crew_memberships (client_id, created_at)
    `);

    await client.query(`
      CREATE TABLE handyman_crew_leads (
        id                          UUID PRIMARY KEY,
        lead_seq                    BIGSERIAL NOT NULL,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        handyman_crew_id            UUID NOT NULL
          REFERENCES handyman_work_crews (id),
        handyman_crew_membership_id UUID NOT NULL
          REFERENCES handyman_crew_memberships (id),
        designated_by_user_id       UUID NOT NULL REFERENCES users (id),
        designated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_crew_leads_seq_unique
        ON handyman_crew_leads (handyman_crew_id, lead_seq)
    `);
    await client.query(`
      CREATE INDEX handyman_crew_leads_scope_idx
        ON handyman_crew_leads (client_id, designated_at)
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_crew_leads_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman crew lead designations are append-only.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_crew_leads_no_update
        BEFORE UPDATE ON handyman_crew_leads
        FOR EACH ROW EXECUTE FUNCTION handyman_crew_leads_block_mutation()
    `);
    await client.query(`
      CREATE TRIGGER handyman_crew_leads_no_delete
        BEFORE DELETE ON handyman_crew_leads
        FOR EACH ROW EXECUTE FUNCTION handyman_crew_leads_block_mutation()
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handyman_crew_leads CASCADE');
    await client.query(
      'DROP FUNCTION IF EXISTS handyman_crew_leads_block_mutation() CASCADE',
    );
    await client.query(
      'DROP TABLE IF EXISTS handyman_crew_memberships CASCADE',
    );
    await client.query('DROP TABLE IF EXISTS handyman_work_crews CASCADE');
  },
};

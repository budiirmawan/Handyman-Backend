import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-06 PART 04 — Handyman quotation customer decision records
 * (FROZEN Decision Freeze F6/F7/F8).
 *
 * Additive: one immutable decision table; reverting `down`; nothing
 * else touched. Exactly one authoritative decision per quotation
 * version (UNIQUE version) plus single-use idempotency key
 * (existing repo convention: trimmed 1..200 key + sha256-hex64
 * fingerprint of the canonical payload; replay-safe, conflict on
 * mismatch). Customer context (tenant company / PIC) is snapshotted
 * from the server-authoritative request lineage — PIC stays NULL when
 * lineage has NULL (never fabricated). Decision vocabulary is exactly
 * APPROVE | REJECT. No UPDATE/DELETE (trigger). NO execution scope,
 * payment, BAST, or FM linkage exists here.
 */
export const migration0394CreateHandymanQuotationDecisions: Migration = {
  id: '0394_create_handyman_quotation_decisions',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_quotation_decisions (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        quotation_id          UUID NOT NULL
          REFERENCES handyman_quotations (id),
        quotation_version_id  UUID NOT NULL
          REFERENCES handyman_quotation_versions (id),
        decision              TEXT NOT NULL,
        tenant_company_id     UUID NOT NULL
          REFERENCES tenant_companies (id),
        tenant_pic_id         UUID REFERENCES tenant_pics (id),
        decided_by_user_id    UUID NOT NULL REFERENCES users (id),
        idempotency_key       TEXT NOT NULL,
        request_fingerprint   TEXT NOT NULL,
        decided_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_quotation_decisions_decision_check
          CHECK (decision IN ('APPROVE', 'REJECT')),
        CONSTRAINT handyman_quotation_decisions_version_unique
          UNIQUE (quotation_version_id),
        CONSTRAINT handyman_quotation_decisions_key_unique
          UNIQUE (idempotency_key),
        CONSTRAINT handyman_quotation_decisions_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_quotation_decisions_fingerprint_check
          CHECK (request_fingerprint ~ '^[0-9a-f]{64}$')
      )
    `);
    await client.query(`
      CREATE INDEX handyman_quotation_decisions_scope_idx
        ON handyman_quotation_decisions (client_id, quotation_id, decided_at)
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_quotation_decision_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman quotation decisions are immutable authoritative facts.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_quotation_decision_no_write
        BEFORE UPDATE OR DELETE ON handyman_quotation_decisions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_quotation_decision_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_quotation_decision_no_write
        ON handyman_quotation_decisions;
      DROP FUNCTION IF EXISTS handyman_quotation_decision_block_mutation;
      DROP TABLE IF EXISTS handyman_quotation_decisions;
    `);
  },
};

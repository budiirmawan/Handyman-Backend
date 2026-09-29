import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-12 PART 04 — BM fee rule definitions bound to EXACT
 * commercial agreement versions (FROZEN
 * `CR-HM-12_START_GOVERNANCE.md` §7/§10 PART 04).
 *
 * One additive immutable table; reverting `down`; nothing else
 * touched:
 *
 *   handyman_bm_fee_rule_definitions
 *     Append-only rule rows authored ONLY while the bound agreement
 *     version is DRAFT (§5 immutable-once-effective; revision = a
 *     new agreement version). Exactly ONE BM fee rule per agreement
 *     version: UNIQUE (agreement_version_id).
 *
 *     - basis: the frozen governed vocabulary, exactly
 *       LABOR_ONLY — the roadmap/matrix default/reference model for
 *       BM fee rules. Configurable means versioned: new lawful
 *       basis values require future governed change, never a free
 *       string.
 *     - mode: DEFAULT (the rule CR-HM-14 consumes for that exact
 *       version) vs REFERENCE (published reference model, never
 *       authoritative for consumption). PART 04 vocabulary.
 *
 *     This table stores NO numeric rule facts at all: no percentage,
 *     no rate, no amount, no fee value — §10 freezes the VOCABULARY
 *     here and forbids entitlement math; any fee VALUE is derived
 *     per transaction by CR-HM-14 from governed transactions plus
 *     this bound rule, never by CR-HM-12 (§7 boundary). Information
 *     Schema law proven by tests: every column is TEXT/UUID/
 *     TIMESTAMPTZ.
 *
 *     UPDATE/DELETE blocked; DRAFT-window INSERT guard mirrors the
 *     0407/0408 family. FK graph reaches only the PART 01 version
 *     table and `users`: zero SaaS subscription/billing/pricebook
 *     reference, zero quotation/ledger reference (B3/B6/B8).
 */
export const migration0409CreateHandymanBmFeeRules: Migration = {
  id: '0409_create_handyman_bm_fee_rules',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_bm_fee_rule_definitions (
        id                     UUID PRIMARY KEY,
        agreement_version_id   UUID NOT NULL
          REFERENCES handyman_commercial_agreement_versions (id),
        basis                  TEXT NOT NULL,
        mode                   TEXT NOT NULL DEFAULT 'DEFAULT',
        idempotency_key        TEXT NOT NULL UNIQUE,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_bm_fee_rule_basis_check
          CHECK (basis IN ('LABOR_ONLY')),
        CONSTRAINT handyman_bm_fee_rule_mode_check
          CHECK (mode IN ('DEFAULT', 'REFERENCE')),
        CONSTRAINT handyman_bm_fee_rule_version_unique
          UNIQUE (agreement_version_id),
        CONSTRAINT handyman_bm_fee_rule_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bm_fee_rule_draft_only()
      RETURNS trigger AS $$
      DECLARE
        version_status TEXT;
      BEGIN
        SELECT status INTO version_status
          FROM handyman_commercial_agreement_versions
          WHERE id = NEW.agreement_version_id;
        IF version_status IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION
            'Handyman BM fee rule definitions may only be authored on a DRAFT agreement version.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bm_fee_rule_draft_only_trigger
        BEFORE INSERT ON handyman_bm_fee_rule_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bm_fee_rule_draft_only();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bm_fee_rule_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman BM fee rule definitions are append-only (supersession lands a new agreement version).';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bm_fee_rule_no_write_trigger
        BEFORE UPDATE OR DELETE ON handyman_bm_fee_rule_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bm_fee_rule_no_write();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_bm_fee_rule_no_write_trigger
        ON handyman_bm_fee_rule_definitions;
      DROP TRIGGER IF EXISTS handyman_bm_fee_rule_draft_only_trigger
        ON handyman_bm_fee_rule_definitions;
      DROP FUNCTION IF EXISTS handyman_bm_fee_rule_no_write;
      DROP FUNCTION IF EXISTS handyman_bm_fee_rule_draft_only;
      DROP TABLE IF EXISTS handyman_bm_fee_rule_definitions;
    `);
  },
};

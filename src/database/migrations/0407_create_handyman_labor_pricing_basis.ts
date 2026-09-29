import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-12 PART 02 — labor & crew pricing-mode basis definitions
 * bound to EXACT commercial agreement versions (FROZEN
 * `CR-HM-12_START_GOVERNANCE.md` §4/§5/§10 PART 02).
 *
 * One additive immutable table; reverting `down`; nothing else
 * touched:
 *
 *   handyman_labor_pricing_basis_definitions
 *     Append-only basis definitions authored ONLY while the bound
 *     agreement version is DRAFT (§5 "immutable once effective" — a
 *     plpgsql guard blocks every INSERT once the version leaves
 *     DRAFT; revision = a new agreement version, never an edit).
 *     LABOR-only here: the material pricing basis is PART 03 and
 *     gets its own surface; BM fee rules are PART 04.
 *
 *     - mode: the frozen pricing-mode vocabulary
 *       HOURLY | FIXED_SCOPE | INSPECTION_FIRST | VISIT_FEE;
 *     - crew_mode: frozen crew application modes PER_HEAD | PER_CREW;
 *       scope-total modes are locked to PER_CREW by CHECK;
 *     - billable_time_basis: the billable-time basis definition
 *       (PRESENCE | ACTUAL_WORK — named from CR-HM-08 §11 published
 *       projections; required for HOURLY, forbidden otherwise, by
 *       CHECK);
 *     - unit_amount NUMERIC(18,2) + currency against the same frozen
 *       9-currency list as 0392 — governed RULE facts, never
 *       transaction charges (no charge/billing/payment/ledger/fee/
 *       tax/discount column exists, and no amount is computed or
 *       posted here).
 *     - UNIQUE (agreement_version_id, mode): at most one definition
 *       per mode per version.
 *     - idempotency_key globally UNIQUE (0394 single-use convention).
 *
 * UPDATE and DELETE are blocked by trigger: the frozen set of an
 * effective version is exactly its rows — no edits, no tombstones.
 * FK graph reaches only the PART 01 version table and `users`; no
 * session, crew, material, quotation, FM or SaaS table is touched
 * (§6/§8: execution inputs are supplied by consumers; this module
 * reads nothing).
 */
export const migration0407CreateHandymanLaborPricingBasis: Migration = {
  id: '0407_create_handyman_labor_pricing_basis',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_labor_pricing_basis_definitions (
        id                     UUID PRIMARY KEY,
        agreement_version_id   UUID NOT NULL
          REFERENCES handyman_commercial_agreement_versions (id),
        mode                   TEXT NOT NULL,
        crew_mode              TEXT NOT NULL DEFAULT 'PER_CREW',
        billable_time_basis    TEXT,
        unit_amount            NUMERIC(18, 2) NOT NULL,
        currency               VARCHAR(3) NOT NULL,
        idempotency_key        TEXT NOT NULL UNIQUE,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_labor_pricing_basis_mode_check
          CHECK (mode IN ('HOURLY', 'FIXED_SCOPE', 'INSPECTION_FIRST',
                          'VISIT_FEE')),
        CONSTRAINT handyman_labor_pricing_basis_crew_mode_check
          CHECK (crew_mode IN ('PER_HEAD', 'PER_CREW')),
        CONSTRAINT handyman_labor_pricing_basis_crew_scope_lock_check
          CHECK (mode NOT IN ('FIXED_SCOPE', 'INSPECTION_FIRST')
                 OR crew_mode = 'PER_CREW'),
        -- COALESCE keeps the OR-chain FALSE (not NULL) when the
        -- nullable column is NULL on HOURLY — a NULL CHECK result
        -- passes, so the refusal must be deterministic.
        CONSTRAINT handyman_labor_pricing_basis_billable_check
          CHECK ((mode = 'HOURLY'
                    AND COALESCE(billable_time_basis IN (
                          'PRESENCE', 'ACTUAL_WORK'), FALSE))
                 OR (mode <> 'HOURLY'
                     AND billable_time_basis IS NULL)),
        CONSTRAINT handyman_labor_pricing_basis_amount_check
          CHECK (unit_amount >= 0),
        CONSTRAINT handyman_labor_pricing_basis_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT handyman_labor_pricing_basis_version_mode_unique
          UNIQUE (agreement_version_id, mode),
        CONSTRAINT handyman_labor_pricing_basis_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_labor_pricing_basis_version_idx
        ON handyman_labor_pricing_basis_definitions (
          agreement_version_id, created_at, id
        )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_labor_pricing_basis_draft_only()
      RETURNS trigger AS $$
      DECLARE
        version_status TEXT;
      BEGIN
        SELECT status INTO version_status
          FROM handyman_commercial_agreement_versions
          WHERE id = NEW.agreement_version_id;
        IF version_status IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION
            'Handyman labor pricing basis definitions may only be authored on a DRAFT agreement version.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_labor_pricing_basis_draft_only_trigger
        BEFORE INSERT ON handyman_labor_pricing_basis_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_labor_pricing_basis_draft_only();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_labor_pricing_basis_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman labor pricing basis definitions are append-only (supersession lands a new agreement version).';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_labor_pricing_basis_no_write_trigger
        BEFORE UPDATE OR DELETE ON handyman_labor_pricing_basis_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_labor_pricing_basis_no_write();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_labor_pricing_basis_no_write_trigger
        ON handyman_labor_pricing_basis_definitions;
      DROP TRIGGER IF EXISTS handyman_labor_pricing_basis_draft_only_trigger
        ON handyman_labor_pricing_basis_definitions;
      DROP FUNCTION IF EXISTS handyman_labor_pricing_basis_no_write;
      DROP FUNCTION IF EXISTS handyman_labor_pricing_basis_draft_only;
      DROP TABLE IF EXISTS handyman_labor_pricing_basis_definitions;
    `);
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-12 PART 06A — BM fee TERM + BENEFICIARY prerequisite
 * persistence (FROZEN `CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md` §3,
 * authorized by `CR-HM-14_PREREQUISITE_DECISION_BM_FEE.md` §2/§3/§5).
 *
 * Two additive immutable tables; reverting `down`; nothing else
 * touched:
 *
 *   handyman_bm_fee_term_definitions
 *     The version-bound NUMERIC BM fee term HARD-1 required: exactly
 *     one term per EXACT agreement version, kind vocabulary closed to
 *     PERCENTAGE_OF_BASIS, rate NUMERIC(7,4) bounded (> 0 AND <= 100).
 *     This is the ONLY numeric fee fact in the repository, and it is
 *     a RULE fact — never a charge, never an entitlement, never a
 *     computed value. No currency column: a percentage is
 *     currency-free; the derived value's currency is CR-HM-14's
 *     governed ledger currency.
 *
 *   handyman_bm_fee_beneficiary_definitions
 *     The explicit version-bound financial beneficiary HARD-2
 *     required: exactly one beneficiary per EXACT agreement version,
 *     kind vocabulary closed to CLIENT_ORGANIZATION whose governed
 *     reference MUST equal the bound version's own client
 *     (same-client chain, trigger-enforced; no channel-attribution,
 *     vendor, or caller inference is representable). No name/free
 *     text, no bank/rail/instrument/wallet/payout column, no status
 *     column.
 *
 * Both tables are DRAFT-window authored (INSERT allowed only while
 * the bound version's status is DRAFT) and totally append-only
 * (UPDATE/DELETE blocked; revision = a new agreement version), the
 * frozen 0407/0408/0409 pattern. Single-use `idempotency_key`
 * UNIQUE. FK graph reaches only `handyman_commercial_agreement_versions`,
 * `clients`, and `users`: zero ledger (CR-HM-13), quotation, session,
 * material, BAST, FM, or SaaS reference.
 *
 * NO fee-value computation, NO entitlement/settlement, NO read
 * contract, NO HTTP exists in this PART (06B owns the reading
 * surface). Each insertion is executed once per DRAFT window;
 * authors are authenticated local users.
 */
export const migration0415CreateHandymanBmFeePrerequisite: Migration = {
  id: '0415_create_handyman_bm_fee_prerequisite',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_bm_fee_term_definitions (
        id                     UUID PRIMARY KEY,
        agreement_version_id   UUID NOT NULL
          REFERENCES handyman_commercial_agreement_versions (id),
        term_kind              TEXT NOT NULL,
        rate_percent           NUMERIC(7, 4) NOT NULL,
        idempotency_key        TEXT NOT NULL UNIQUE,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_bm_fee_term_kind_check
          CHECK (term_kind IN ('PERCENTAGE_OF_BASIS')),
        CONSTRAINT handyman_bm_fee_term_rate_check
          CHECK (rate_percent > 0 AND rate_percent <= 100),
        CONSTRAINT handyman_bm_fee_term_version_unique
          UNIQUE (agreement_version_id),
        CONSTRAINT handyman_bm_fee_term_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_bm_fee_term_version_idx
        ON handyman_bm_fee_term_definitions (
          agreement_version_id, created_at, id
        )
    `);

    await client.query(`
      CREATE TABLE handyman_bm_fee_beneficiary_definitions (
        id                       UUID PRIMARY KEY,
        agreement_version_id     UUID NOT NULL
          REFERENCES handyman_commercial_agreement_versions (id),
        beneficiary_kind         TEXT NOT NULL,
        beneficiary_reference_id UUID NOT NULL REFERENCES clients (id),
        idempotency_key          TEXT NOT NULL UNIQUE,
        created_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_bm_fee_beneficiary_kind_check
          CHECK (beneficiary_kind IN ('CLIENT_ORGANIZATION')),
        CONSTRAINT handyman_bm_fee_beneficiary_version_unique
          UNIQUE (agreement_version_id),
        CONSTRAINT handyman_bm_fee_beneficiary_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_bm_fee_beneficiary_version_idx
        ON handyman_bm_fee_beneficiary_definitions (
          agreement_version_id, created_at, id
        )
    `);

    // DRAFT-window law (shared by both tables: identical
    // `agreement_version_id` shape, no per-table duplication). An
    // unknown version leaves version_status NULL and is refused by
    // the `agreement_version_id` FK instead — the guard governs
    // REAL versions only, never masking the FK refusal.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bm_fee_prerequisite_draft_only()
      RETURNS trigger AS $$
      DECLARE
        version_status TEXT;
      BEGIN
        SELECT status INTO version_status
          FROM handyman_commercial_agreement_versions
          WHERE id = NEW.agreement_version_id;
        IF version_status IS NOT NULL
           AND version_status <> 'DRAFT'
        THEN
          RAISE EXCEPTION
            'Handyman BM fee term/beneficiary definitions may only be authored on a DRAFT agreement version.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bm_fee_term_draft_only_trigger
        BEFORE INSERT ON handyman_bm_fee_term_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bm_fee_prerequisite_draft_only()
    `);
    await client.query(`
      CREATE TRIGGER handyman_bm_fee_beneficiary_draft_only_trigger
        BEFORE INSERT ON handyman_bm_fee_beneficiary_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bm_fee_prerequisite_draft_only()
    `);

    // Append-only law (shared): no edits, no tombstones; the frozen
    // set of a version is exactly its rows.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bm_fee_prerequisite_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman BM fee term/beneficiary definitions are append-only (supersession lands a new agreement version).';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bm_fee_term_no_write_trigger
        BEFORE UPDATE OR DELETE ON handyman_bm_fee_term_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bm_fee_prerequisite_no_write()
    `);
    await client.query(`
      CREATE TRIGGER handyman_bm_fee_beneficiary_no_write_trigger
        BEFORE UPDATE OR DELETE ON handyman_bm_fee_beneficiary_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bm_fee_prerequisite_no_write()
    `);

    // Same-client chain: a CLIENT_ORGANIZATION beneficiary is the
    // bound agreement version's own client — nothing else, ever.
    // `handyman_commercial_agreement_versions` carries no client
    // column (0406), so the version's client is resolved through its
    // parent agreement — the FK-anchored composition path, never a
    // caller-supplied value. An unknown version leaves version_client
    // NULL and is refused by the agreement_version_id FK instead.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_bm_fee_beneficiary_client_consistency()
      RETURNS trigger AS $$
      DECLARE
        version_client UUID;
      BEGIN
        SELECT a.client_id INTO version_client
          FROM handyman_commercial_agreement_versions v
          JOIN handyman_commercial_agreements a
            ON a.id = v.agreement_id
         WHERE v.id = NEW.agreement_version_id;
        IF version_client IS NOT NULL
           AND NEW.beneficiary_reference_id IS DISTINCT FROM version_client
        THEN
          RAISE EXCEPTION
            'Handyman BM fee beneficiary reference must equal the bound agreement version client.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bm_fee_beneficiary_client_trigger
        BEFORE INSERT ON handyman_bm_fee_beneficiary_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_bm_fee_beneficiary_client_consistency()
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_bm_fee_beneficiary_client_trigger
        ON handyman_bm_fee_beneficiary_definitions;
      DROP TRIGGER IF EXISTS handyman_bm_fee_beneficiary_no_write_trigger
        ON handyman_bm_fee_beneficiary_definitions;
      DROP TRIGGER IF EXISTS handyman_bm_fee_beneficiary_draft_only_trigger
        ON handyman_bm_fee_beneficiary_definitions;
      DROP TRIGGER IF EXISTS handyman_bm_fee_term_no_write_trigger
        ON handyman_bm_fee_term_definitions;
      DROP TRIGGER IF EXISTS handyman_bm_fee_term_draft_only_trigger
        ON handyman_bm_fee_term_definitions;
      DROP FUNCTION IF EXISTS handyman_bm_fee_beneficiary_client_consistency;
      DROP FUNCTION IF EXISTS handyman_bm_fee_prerequisite_no_write;
      DROP FUNCTION IF EXISTS handyman_bm_fee_prerequisite_draft_only;
      DROP TABLE IF EXISTS handyman_bm_fee_beneficiary_definitions;
      DROP TABLE IF EXISTS handyman_bm_fee_term_definitions;
    `);
  },
};

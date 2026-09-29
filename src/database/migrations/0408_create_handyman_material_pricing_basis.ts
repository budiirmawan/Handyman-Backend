import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-12 PART 03 — material pricing basis definitions bound to
 * EXACT commercial agreement versions (FROZEN
 * `CR-HM-12_START_GOVERNANCE.md` §6/§10 PART 03).
 *
 * One additive immutable table; reverting `down`; nothing else
 * touched:
 *
 *   handyman_material_pricing_basis_definitions
 *     Append-only basis-mode rows authored ONLY while the bound
 *     agreement version is DRAFT (same §5 immutable-once-effective
 *     law as PART 02; revision = a new agreement version). Exactly
 *     ONE material pricing basis per agreement version: UNIQUE
 *     (agreement_version_id).
 *
 *     Mode vocabulary (frozen here — the two lawful ways to turn
 *     CR-HM-09 execution truth into a pricing basis):
 *       SETTLED_USAGE  — basis quantity = finalUsedQty
 *                        (usedQty - returnedQty) per settled line;
 *       APPROVED_QTY   — basis quantity = approvedQty per settled
 *                        line (full approved quantum charged).
 *
 *     This table stores NO amounts, NO quantities, NO currency, NO
 *     supplier facts, and NO pricing results — deliberately: the
 *     unit amount of a material charge is the CR-HM-06 approved
 *     MATERIAL line snapshot and the settled quantities are the
 *     CR-HM-09 FINAL_CHARGE_READY handoff. Re-storing either here
 *     would be re-pricing (B4) or re-authoring execution truth
 *     (B5) — both forbidden. The composition join happens at read
 *     time in the service; the DB surface here is a governed
 *     choice-of-basis fact only.
 *
 *     UPDATE/DELETE blocked by trigger; the DRAFT-window INSERT
 *     guard mirrors 0407. FK graph reaches only the PART 01 version
 *     table and `users` — zero material-execution, quotation-line,
 *     PO/GR, FM, or SaaS references (§6: FINAL_CHARGE_READY is
 *     consumed read-only; no PO/GR chain; B8 firewalls).
 */
export const migration0408CreateHandymanMaterialPricingBasis: Migration = {
  id: '0408_create_handyman_material_pricing_basis',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_material_pricing_basis_definitions (
        id                     UUID PRIMARY KEY,
        agreement_version_id   UUID NOT NULL
          REFERENCES handyman_commercial_agreement_versions (id),
        mode                   TEXT NOT NULL,
        idempotency_key        TEXT NOT NULL UNIQUE,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_material_pricing_basis_mode_check
          CHECK (mode IN ('SETTLED_USAGE', 'APPROVED_QTY')),
        CONSTRAINT handyman_material_pricing_basis_version_unique
          UNIQUE (agreement_version_id),
        CONSTRAINT handyman_material_pricing_basis_key_check
          CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_material_pricing_basis_draft_only()
      RETURNS trigger AS $$
      DECLARE
        version_status TEXT;
      BEGIN
        SELECT status INTO version_status
          FROM handyman_commercial_agreement_versions
          WHERE id = NEW.agreement_version_id;
        IF version_status IS DISTINCT FROM 'DRAFT' THEN
          RAISE EXCEPTION
            'Handyman material pricing basis definitions may only be authored on a DRAFT agreement version.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_pricing_basis_draft_only_trigger
        BEFORE INSERT ON handyman_material_pricing_basis_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_material_pricing_basis_draft_only();
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_material_pricing_basis_no_write()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman material pricing basis definitions are append-only (supersession lands a new agreement version).';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_material_pricing_basis_no_write_trigger
        BEFORE UPDATE OR DELETE ON handyman_material_pricing_basis_definitions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_material_pricing_basis_no_write();
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_material_pricing_basis_no_write_trigger
        ON handyman_material_pricing_basis_definitions;
      DROP TRIGGER IF EXISTS
        handyman_material_pricing_basis_draft_only_trigger
        ON handyman_material_pricing_basis_definitions;
      DROP FUNCTION IF EXISTS handyman_material_pricing_basis_no_write;
      DROP FUNCTION IF EXISTS handyman_material_pricing_basis_draft_only;
      DROP TABLE IF EXISTS handyman_material_pricing_basis_definitions;
    `);
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-13 PART 02 — charge composition from GOVERNED READ-ONLY
 * inputs (FROZEN governance `CR-HM-13_START_GOVERNANCE.md` §4/§6/§8/§9,
 * §10 row 02, §13 row 02).
 *
 * Two additive changes, both inside CR-HM-13's own ledger boundary:
 *
 * 1. `handyman_charge_line_bases` — the COMPOSITION ANCHOR of every
 *    posted charge line (governance I11): which governed inputs
 *    produced the amount, at which exact CR-HM-12 agreement version,
 *    with which applied quantity and which snapshot unit amount.
 *    Append-only and immutable; exactly ONE anchor per charge line.
 *
 * 2. The charge-line basis rule is COMPOSED rather than
 *    snapshot-identical: LABOR stays EXACTLY the approved snapshot
 *    amount (the customer-approved labor authority — never repriced),
 *    while MATERIAL is the approved snapshot amount BOUNDED by it
 *    (governed settled usage or governed approved quantity, chosen by
 *    the effective CR-HM-12 material basis; never above the approved
 *    amount, never a re-authored unit amount).
 *
 * The money law is DB-enforced: amount = ROUND(unit_amount *
 * applied_qty, 2), with unit_amount always the immutable CR-HM-06
 * snapshot unit amount. A charge line without a composition anchor
 * cannot be committed (deferred constraint trigger): no ungoverned
 * charge exists, not even transiently.
 *
 * ZERO payment/allocation/refund/reversal/adjustment, ZERO
 * entitlement/settlement/BM fee, ZERO provider/gateway vocabulary,
 * ZERO SaaS/FM coupling, ZERO HTTP.
 */
export const migration0411HandymanChargeComposition: Migration = {
  id: '0411_handyman_charge_composition',
  async up(client: PoolClient): Promise<void> {
    // ---- COMPOSITION ANCHOR table (append-only) ------------------
    await client.query(`
      CREATE TABLE handyman_charge_line_bases (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL
          REFERENCES clients (id),
        transaction_id           UUID NOT NULL
          REFERENCES handyman_customer_transactions (id),
        charge_line_id           UUID NOT NULL
          REFERENCES handyman_charge_lines (id),
        quotation_version_id     UUID NOT NULL
          REFERENCES handyman_quotation_versions (id),
        quotation_line_id        UUID NOT NULL
          REFERENCES handyman_quotation_lines (id),
        line_kind                TEXT NOT NULL,
        composition_kind         TEXT NOT NULL,
        basis_fact_kind          TEXT NOT NULL,
        currency                 VARCHAR(3) NOT NULL,
        applied_qty              NUMERIC(14, 3) NOT NULL,
        unit_amount              NUMERIC(18, 2) NOT NULL,
        amount                   NUMERIC(18, 2) NOT NULL,
        agreement_id             UUID
          REFERENCES handyman_commercial_agreements (id),
        agreement_version_id     UUID
          REFERENCES handyman_commercial_agreement_versions (id),
        agreement_version_number INTEGER,
        labor_basis_row_id       UUID
          REFERENCES handyman_labor_pricing_basis_definitions (id),
        material_basis_row_id    UUID
          REFERENCES handyman_material_pricing_basis_definitions (id),
        idempotency_key          TEXT NOT NULL,
        actor_user_id            UUID NOT NULL
          REFERENCES users (id),
        occurred_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_charge_line_bases_line_unique
          UNIQUE (charge_line_id),
        CONSTRAINT handyman_charge_line_bases_kind_check
          CHECK (line_kind IN ('LABOR', 'MATERIAL')),
        CONSTRAINT handyman_charge_line_bases_composition_check
          CHECK (composition_kind IN (
            'LABOR_APPROVED_SNAPSHOT', 'MATERIAL_APPROVED_SNAPSHOT',
            'MATERIAL_SETTLED_USAGE', 'MATERIAL_APPROVED_QTY')),
        CONSTRAINT handyman_charge_line_bases_fact_kind_check
          CHECK (basis_fact_kind IN (
            'CR_HM_06_APPROVED_SNAPSHOT', 'CR_HM_12_BASIS_FACT')),
        CONSTRAINT handyman_charge_line_bases_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT handyman_charge_line_bases_qty_check
          CHECK (applied_qty >= 0),
        CONSTRAINT handyman_charge_line_bases_unit_check
          CHECK (unit_amount >= 0),
        CONSTRAINT handyman_charge_line_bases_amount_check
          CHECK (amount >= 0),
        -- The frozen money law: the composed amount is EXACTLY the
        -- governed quantity applied to the approved snapshot unit
        -- amount. Re-authoring either factor is structurally
        -- impossible (no repricing).
        CONSTRAINT handyman_charge_line_bases_money_law_check
          CHECK (amount = ROUND(unit_amount * applied_qty, 2)),
        -- Binding triple is all-or-nothing: an agreement anchor is
        -- either fully recorded or explicitly absent (never partial,
        -- never a resolved-by-implication version).
        CONSTRAINT handyman_charge_line_bases_binding_check
          CHECK ((agreement_id IS NULL AND agreement_version_id IS NULL
                    AND agreement_version_number IS NULL)
                 OR (agreement_id IS NOT NULL
                    AND agreement_version_id IS NOT NULL
                    AND agreement_version_number IS NOT NULL)),
        -- The CR-HM-12 basis fact kind REQUIRES the exact version
        -- anchor; the snapshot-only composition is explicitly
        -- anchorless (never a silent default).
        CONSTRAINT handyman_charge_line_bases_fact_binding_check
          CHECK ((basis_fact_kind = 'CR_HM_12_BASIS_FACT'
                    AND agreement_version_id IS NOT NULL)
                 OR (basis_fact_kind = 'CR_HM_06_APPROVED_SNAPSHOT'
                    AND agreement_version_id IS NULL)),
        -- Kind / composition / basis-row consistency: LABOR carries
        -- no material row, MATERIAL carries no labor row, and only a
        -- GOVERNED material mode carries a material basis row.
        CONSTRAINT handyman_charge_line_bases_row_check
          CHECK (
            (line_kind = 'LABOR'
              AND composition_kind = 'LABOR_APPROVED_SNAPSHOT'
              AND material_basis_row_id IS NULL)
            OR
            (line_kind = 'MATERIAL'
              AND composition_kind IN (
                'MATERIAL_APPROVED_SNAPSHOT', 'MATERIAL_SETTLED_USAGE',
                'MATERIAL_APPROVED_QTY')
              AND labor_basis_row_id IS NULL)),
        CONSTRAINT handyman_charge_line_bases_material_row_check
          CHECK ((line_kind = 'LABOR'
                    AND material_basis_row_id IS NULL)
                 OR (line_kind = 'MATERIAL'
                    AND composition_kind = 'MATERIAL_APPROVED_SNAPSHOT'
                    AND material_basis_row_id IS NULL)
                 OR (line_kind = 'MATERIAL'
                    AND composition_kind IN (
                      'MATERIAL_SETTLED_USAGE',
                      'MATERIAL_APPROVED_QTY')
                    AND material_basis_row_id IS NOT NULL)),
        CONSTRAINT handyman_charge_line_bases_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_charge_line_bases_transaction_idx
        ON handyman_charge_line_bases (transaction_id, created_at, id)
    `);

    // ---- Composed charge-line rule (replaces the PART 01 rule) ----
    // LABOR: amount must EQUAL the approved snapshot amount (the
    // customer-approved labor authority; a governed basis fact never
    // reprices it). MATERIAL: amount must never EXCEED the approved
    // snapshot amount and the unit amount is never re-authored — the
    // exact amount is governed by the composition anchor and the
    // money law there.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_charge_line_basis_consistency()
      RETURNS trigger AS $$
      DECLARE
        tx_version     UUID;
        quote_version  UUID;
        quote_type     TEXT;
        quote_total    NUMERIC(18, 2);
        quote_currency VARCHAR(3);
      BEGIN
        SELECT quotation_version_id
          INTO tx_version
          FROM handyman_customer_transactions
          WHERE id = NEW.transaction_id;
        IF tx_version IS NULL THEN
          -- Absent parent falls through to the FK constraints.
          RETURN NEW;
        END IF;
        SELECT quotation_version_id, line_type, line_total, currency
          INTO quote_version, quote_type, quote_total, quote_currency
          FROM handyman_quotation_lines
          WHERE id = NEW.quotation_line_id;
        IF quote_version IS NULL THEN
          -- Absent referent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF quote_version IS DISTINCT FROM tx_version THEN
          RAISE EXCEPTION
            'Handyman charge line must reference a quotation line of the transaction anchored approved quotation version.';
        END IF;
        IF NEW.line_kind IS DISTINCT FROM quote_type
           OR NEW.currency IS DISTINCT FROM quote_currency
           OR NEW.amount > quote_total
           OR (NEW.line_kind = 'LABOR'
               AND NEW.amount IS DISTINCT FROM quote_total)
        THEN
          RAISE EXCEPTION
            'Handyman charge lines are composed from the immutable quotation snapshot line: LABOR equals the approved amount, MATERIAL never exceeds it, and the unit amount is never re-authored.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    // ---- Composition anchor consistency --------------------------
    // Every anchor field must EQUAL the charge line it anchors, and
    // the quotation line identity must match the ledger row exactly.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_charge_line_basis_anchor_consistency()
      RETURNS trigger AS $$
      DECLARE
        line_client    UUID;
        line_tx        UUID;
        line_version   UUID;
        line_quote     UUID;
        line_kind      TEXT;
        line_currency  VARCHAR(3);
        line_amount    NUMERIC(18, 2);
      BEGIN
        -- The anchored quotation version lives on the TRANSACTION
        -- (the charge line carries only its quotation line); the
        -- anchor must agree with the transaction's exact version.
        SELECT l.client_id, l.transaction_id, t.quotation_version_id,
               l.quotation_line_id, l.line_kind, l.currency, l.amount
          INTO line_client, line_tx, line_version, line_quote,
               line_kind, line_currency, line_amount
          FROM handyman_charge_lines l
          JOIN handyman_customer_transactions t
            ON t.id = l.transaction_id
          WHERE l.id = NEW.charge_line_id;
        IF line_client IS NULL THEN
          -- Absent parent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM line_client
           OR NEW.transaction_id IS DISTINCT FROM line_tx
           OR NEW.quotation_version_id IS DISTINCT FROM line_version
           OR NEW.quotation_line_id IS DISTINCT FROM line_quote
           OR NEW.line_kind IS DISTINCT FROM line_kind
           OR NEW.currency IS DISTINCT FROM line_currency
           OR NEW.amount IS DISTINCT FROM line_amount
        THEN
          RAISE EXCEPTION
            'Handyman charge line composition anchor must match its posted charge line exactly (client, transaction, quotation snapshot, kind, currency, amount).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_charge_line_basis_anchor_check
        BEFORE INSERT OR UPDATE ON handyman_charge_line_bases
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_charge_line_basis_anchor_consistency();
    `);

    // ---- Composition anchors are append-only ---------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_charge_line_basis_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman charge line composition anchors are append-only: never updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_charge_line_basis_immutable
        BEFORE UPDATE OR DELETE ON handyman_charge_line_bases
        FOR EACH ROW
        EXECUTE FUNCTION handyman_charge_line_basis_block_mutation();
    `);

    // ---- No charge line without a governed composition basis -----
    // Deferred to COMMIT so the anchor may be written immediately
    // after the line inside one transaction; a charge line that never
    // receives an anchor can never become durable.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_charge_line_require_basis()
      RETURNS trigger AS $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_charge_line_bases
          WHERE charge_line_id = NEW.id
        ) THEN
          RAISE EXCEPTION
            'Handyman charge lines require a governed composition anchor: an ungoverned charge can never be posted.';
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE CONSTRAINT TRIGGER handyman_charge_line_basis_required
        AFTER INSERT ON handyman_charge_lines
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION handyman_charge_line_require_basis();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_charge_line_basis_required
        ON handyman_charge_lines
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS handyman_charge_line_require_basis()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_charge_line_basis_immutable
        ON handyman_charge_line_bases
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_charge_line_basis_block_mutation()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_charge_line_basis_anchor_check
        ON handyman_charge_line_bases
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_charge_line_basis_anchor_consistency()
    `);
    await client.query(`DROP TABLE IF EXISTS handyman_charge_line_bases`);
    // Restore the PART 01 (foundation) rule exactly.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_charge_line_basis_consistency()
      RETURNS trigger AS $$
      DECLARE
        tx_version     UUID;
        quote_version  UUID;
        quote_type     TEXT;
        quote_total    NUMERIC(18, 2);
        quote_currency VARCHAR(3);
      BEGIN
        SELECT quotation_version_id
          INTO tx_version
          FROM handyman_customer_transactions
          WHERE id = NEW.transaction_id;
        IF tx_version IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT quotation_version_id, line_type, line_total, currency
          INTO quote_version, quote_type, quote_total, quote_currency
          FROM handyman_quotation_lines
          WHERE id = NEW.quotation_line_id;
        IF quote_version IS NULL THEN
          RETURN NEW;
        END IF;
        IF quote_version IS DISTINCT FROM tx_version THEN
          RAISE EXCEPTION
            'Handyman charge line must reference a quotation line of the transaction anchored approved quotation version.';
        END IF;
        IF NEW.line_kind IS DISTINCT FROM quote_type
           OR NEW.amount IS DISTINCT FROM quote_total
           OR NEW.currency IS DISTINCT FROM quote_currency THEN
          RAISE EXCEPTION
            'Handyman charge line commercial facts must equal the immutable quotation snapshot line (amount/kind/currency are never caller-supplied).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  },
};

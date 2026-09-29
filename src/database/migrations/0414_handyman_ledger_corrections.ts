import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-13 PART 05 — REFUND / REVERSAL / ADJUSTMENT (FROZEN
 * governance `CR-HM-13_START_GOVERNANCE.md` §7/§8/§9/§10, §13 row 05).
 *
 * ONE new table inside CR-HM-13's ledger boundary:
 * `handyman_ledger_corrections` — the forward-only correction facts.
 * Financial history is NEVER rewritten (§7.1): every correction is a
 * NEW dated fact carrying its own actor and reason, bound to the exact
 * prior fact (or transaction/line) it corrects. The three kinds are
 * NEVER collapsed (§7.2):
 *
 *   - REFUND     — returns funds to the customer. Source: a CONFIRMED
 *                  payment. Bound: Σ refunds of a payment ≤ what was
 *                  actually RECEIVED AND APPLIED (its allocations, net
 *                  of reversals) — fail-closed.
 *   - REVERSAL   — negates ONE specific prior fact and is bound to that
 *                  source id (an allocation, or a payment). The amount
 *                  must EQUAL the source fact's amount, and a fact may
 *                  be reversed AT MOST ONCE (partial unique index).
 *                  Reversing a payment additionally requires that its
 *                  allocations are no longer live.
 *   - ADJUSTMENT — an explicit, REASONED delta against a transaction or
 *                  ONE charge line. It never rewrites the underlying
 *                  line (charge lines are immutable); the delta is a
 *                  separate fact bounded by the line amount, or by the
 *                  transaction's total charge for transaction scope.
 *
 * Structural laws (DB-enforced):
 *  1. Same transaction, always: composite FKs bind every correction —
 *     and every source id — to ONE ledger transaction, so a correction
 *     can never migrate an amount between transactions or clients
 *     (§7.5);
 *  2. ONE currency: the correction currency is FK-bound to the
 *     transaction's own single currency (no FX, no implicit rate);
 *  3. amount > 0 and NUMERIC(18,2): direction is carried by the fact
 *     kind, never by a negative literal (§4.7/I6/I7);
 *  4. kind ↔ source consistency is a CHECK constraint (a refund has a
 *     payment source and nothing else; a reversal has exactly one
 *     allocation or payment source; an adjustment has one line or the
 *     transaction);
 *  5. append-only and immutable: UPDATE and DELETE are refused;
 *  6. single-use idempotency scoped to the transaction
 *     (UNIQUE (transaction_id, idempotency_key)): replays converge on
 *     the SAME correction fact (§9).
 *
 * ZERO entitlement/settlement/BM fee, ZERO provider/gateway vocabulary,
 * ZERO writes into CR-HM-06/09/11 or any other module (B5), ZERO HTTP.
 */
export const migration0414HandymanLedgerCorrections: Migration = {
  id: '0414_handyman_ledger_corrections',
  async up(client: PoolClient): Promise<void> {
    // ---- Composite-FK prerequisite (additive) --------------------
    // Lets a correction name an ALLOCATION fact and prove, by foreign
    // key, that the allocation sits in the same ledger transaction.
    await client.query(`
      ALTER TABLE handyman_payment_allocations
        ADD CONSTRAINT handyman_payment_allocations_id_transaction_unique
        UNIQUE (id, transaction_id)
    `);

    // ---- CORRECTION facts (forward-only, append-only) ------------
    await client.query(`
      CREATE TABLE handyman_ledger_corrections (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL
          REFERENCES clients (id),
        transaction_id       UUID NOT NULL,
        correction_kind      TEXT NOT NULL,
        source_kind          TEXT NOT NULL,
        source_payment_id    UUID,
        source_allocation_id UUID,
        source_charge_line_id UUID,
        currency             VARCHAR(3) NOT NULL,
        amount               NUMERIC(18, 2) NOT NULL,
        reason               VARCHAR(200) NOT NULL,
        corrected_by_user_id UUID NOT NULL
          REFERENCES users (id),
        idempotency_key      TEXT NOT NULL,
        occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_ledger_corrections_tx_client_fk
          FOREIGN KEY (transaction_id, client_id)
            REFERENCES handyman_customer_transactions (id, client_id),
        CONSTRAINT handyman_ledger_corrections_tx_currency_fk
          FOREIGN KEY (transaction_id, currency)
            REFERENCES handyman_customer_transactions (id, currency),
        CONSTRAINT handyman_ledger_corrections_payment_fk
          FOREIGN KEY (source_payment_id, transaction_id)
            REFERENCES handyman_customer_payments (id, transaction_id),
        CONSTRAINT handyman_ledger_corrections_allocation_fk
          FOREIGN KEY (source_allocation_id, transaction_id)
            REFERENCES handyman_payment_allocations (id, transaction_id),
        CONSTRAINT handyman_ledger_corrections_charge_line_fk
          FOREIGN KEY (source_charge_line_id, transaction_id)
            REFERENCES handyman_charge_lines (id, transaction_id),
        CONSTRAINT handyman_ledger_corrections_kind_check
          CHECK (correction_kind IN ('REFUND', 'REVERSAL', 'ADJUSTMENT')),
        CONSTRAINT handyman_ledger_corrections_source_check
          CHECK (source_kind IN (
            'PAYMENT', 'ALLOCATION', 'CHARGE_LINE', 'TRANSACTION')),
        CONSTRAINT handyman_ledger_corrections_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT handyman_ledger_corrections_amount_check
          CHECK (amount > 0),
        CONSTRAINT handyman_ledger_corrections_reason_check
          CHECK (char_length(btrim(reason)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_ledger_corrections_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_ledger_corrections_key_unique
          UNIQUE (transaction_id, idempotency_key),
        -- Kind <-> source shape: exactly one source id where required.
        CONSTRAINT handyman_ledger_corrections_shape_check
          CHECK (
            (correction_kind = 'REFUND'
              AND source_kind = 'PAYMENT'
              AND source_payment_id IS NOT NULL
              AND source_allocation_id IS NULL
              AND source_charge_line_id IS NULL)
            OR (correction_kind = 'REVERSAL'
              AND source_kind IN ('PAYMENT', 'ALLOCATION')
              AND ((source_kind = 'PAYMENT'
                    AND source_payment_id IS NOT NULL
                    AND source_allocation_id IS NULL)
                OR (source_kind = 'ALLOCATION'
                    AND source_allocation_id IS NOT NULL
                    AND source_payment_id IS NULL))
              AND source_charge_line_id IS NULL)
            OR (correction_kind = 'ADJUSTMENT'
              AND source_kind IN ('CHARGE_LINE', 'TRANSACTION')
              AND ((source_kind = 'CHARGE_LINE'
                    AND source_charge_line_id IS NOT NULL)
                OR (source_kind = 'TRANSACTION'
                    AND source_charge_line_id IS NULL))
              AND source_payment_id IS NULL
              AND source_allocation_id IS NULL))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_ledger_corrections_transaction_idx
        ON handyman_ledger_corrections
        (transaction_id, occurred_at, id)
    `);
    await client.query(`
      CREATE INDEX handyman_ledger_corrections_payment_idx
        ON handyman_ledger_corrections (source_payment_id)
        WHERE source_payment_id IS NOT NULL
    `);
    // A prior fact may be reversed AT MOST ONCE (§7.2, fail-closed).
    await client.query(`
      CREATE UNIQUE INDEX handyman_ledger_corrections_reversal_payment_idx
        ON handyman_ledger_corrections (source_payment_id)
        WHERE correction_kind = 'REVERSAL'
          AND source_payment_id IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_ledger_corrections_reversal_alloc_idx
        ON handyman_ledger_corrections (source_allocation_id)
        WHERE correction_kind = 'REVERSAL'
          AND source_allocation_id IS NOT NULL
    `);

    // ---- Correction invariants -----------------------------------
    // Checked in-database so the laws hold against EVERY writer. All
    // amounts are NUMERIC: money never passes through a float here.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_ledger_correction_guard()
      RETURNS trigger AS $$
      DECLARE
        tx_currency        VARCHAR(3);
        pay_status         TEXT;
        pay_tx             UUID;
        pay_currency       VARCHAR(3);
        pay_amount         NUMERIC(18, 2);
        alloc_tx           UUID;
        alloc_currency     VARCHAR(3);
        alloc_amount       NUMERIC(18, 2);
        alloc_payment      UUID;
        line_tx            UUID;
        line_currency      VARCHAR(3);
        line_amount        NUMERIC(18, 2);
        applied            NUMERIC(18, 2);
        refunded           NUMERIC(18, 2);
        live_allocations   INTEGER;
        reversed_alloc     NUMERIC(18, 2);
        line_total         NUMERIC(18, 2);
        line_reversed      NUMERIC(18, 2);
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman ledger corrections are forward-only facts: never deleted.';
        END IF;
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION
            'Handyman ledger corrections are forward-only facts: a correction of a correction is a NEW correction, never an edit.';
        END IF;

        SELECT currency INTO tx_currency
          FROM handyman_customer_transactions
          WHERE id = NEW.transaction_id;
        IF tx_currency IS NULL THEN
          -- Absent transaction falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.currency IS DISTINCT FROM tx_currency THEN
          RAISE EXCEPTION
            'Handyman ledger correction must stay in the ledger transaction currency (no conversion, no implicit rate).';
        END IF;

        -- ---------- REFUND: received AND APPLIED bound ----------
        IF NEW.correction_kind = 'REFUND' THEN
          SELECT status, transaction_id, currency, amount
            INTO pay_status, pay_tx, pay_currency, pay_amount
            FROM handyman_customer_payments
            WHERE id = NEW.source_payment_id;
          IF pay_tx IS DISTINCT FROM NEW.transaction_id
             OR pay_currency IS DISTINCT FROM tx_currency
          THEN
            RAISE EXCEPTION
              'Handyman refund must reference a payment of the same ledger transaction and currency.';
          END IF;
          IF pay_status IS DISTINCT FROM 'CONFIRMED' THEN
            RAISE EXCEPTION
              'Only a CONFIRMED Handyman customer payment may be refunded.';
          END IF;
          -- Received AND APPLIED: allocations of this payment, net of
          -- the allocations already reversed.
          SELECT COALESCE(SUM(a.amount), 0) INTO applied
            FROM handyman_payment_allocations a
            WHERE a.payment_id = NEW.source_payment_id;
          SELECT COALESCE(SUM(c.amount), 0) INTO reversed_alloc
            FROM handyman_ledger_corrections c
            WHERE c.correction_kind = 'REVERSAL'
              AND c.source_allocation_id IN (
                SELECT a.id FROM handyman_payment_allocations a
                WHERE a.payment_id = NEW.source_payment_id);
          applied := applied - reversed_alloc;
          SELECT COALESCE(SUM(c.amount), 0) INTO refunded
            FROM handyman_ledger_corrections c
            WHERE c.correction_kind = 'REFUND'
              AND c.source_payment_id = NEW.source_payment_id;
          IF refunded + NEW.amount > applied THEN
            RAISE EXCEPTION
              'Handyman refund exceeds what was actually received and applied: a refund can never exceed the applied amount, net of reversals.';
          END IF;
          RETURN NEW;
        END IF;

        -- ---------- REVERSAL: exact negation, at most once ------
        IF NEW.correction_kind = 'REVERSAL' THEN
          IF NEW.source_kind = 'ALLOCATION' THEN
            SELECT transaction_id, currency, amount, payment_id
              INTO alloc_tx, alloc_currency, alloc_amount, alloc_payment
              FROM handyman_payment_allocations
              WHERE id = NEW.source_allocation_id;
            IF alloc_tx IS DISTINCT FROM NEW.transaction_id
               OR alloc_currency IS DISTINCT FROM tx_currency
            THEN
              RAISE EXCEPTION
                'Handyman reversal must reference an allocation of the same ledger transaction and currency.';
            END IF;
            IF NEW.amount IS DISTINCT FROM alloc_amount THEN
              RAISE EXCEPTION
                'Handyman reversal of an allocation must equal the allocation amount exactly (a fact is negated, never partially edited).';
            END IF;
            RETURN NEW;
          END IF;
          -- Payment reversal: only confirmed funds, only once fully
          -- un-applied (no live allocations may remain).
          SELECT status, transaction_id, currency, amount
            INTO pay_status, pay_tx, pay_currency, pay_amount
            FROM handyman_customer_payments
            WHERE id = NEW.source_payment_id;
          IF pay_tx IS DISTINCT FROM NEW.transaction_id
             OR pay_currency IS DISTINCT FROM tx_currency
          THEN
            RAISE EXCEPTION
              'Handyman reversal must reference a payment of the same ledger transaction and currency.';
          END IF;
          IF pay_status IS DISTINCT FROM 'CONFIRMED' THEN
            RAISE EXCEPTION
              'Only a CONFIRMED Handyman customer payment may be reversed.';
          END IF;
          IF NEW.amount IS DISTINCT FROM pay_amount THEN
            RAISE EXCEPTION
              'Handyman reversal of a payment must equal the payment amount exactly.';
          END IF;
          SELECT COUNT(*) INTO live_allocations
            FROM handyman_payment_allocations a
            WHERE a.payment_id = NEW.source_payment_id
              AND NOT EXISTS (
                SELECT 1 FROM handyman_ledger_corrections c
                WHERE c.correction_kind = 'REVERSAL'
                  AND c.source_allocation_id = a.id);
          IF live_allocations > 0 THEN
            RAISE EXCEPTION
              'Handyman payment reversal requires that every allocation of the payment is reversed first (funds cannot be un-received while still applied).';
          END IF;
          RETURN NEW;
        END IF;

        -- ---------- ADJUSTMENT: reasoned delta within bounds ----
        IF NEW.source_kind = 'CHARGE_LINE' THEN
          SELECT transaction_id, currency, amount
            INTO line_tx, line_currency, line_amount
            FROM handyman_charge_lines
            WHERE id = NEW.source_charge_line_id;
          IF line_tx IS DISTINCT FROM NEW.transaction_id
             OR line_currency IS DISTINCT FROM tx_currency
          THEN
            RAISE EXCEPTION
              'Handyman adjustment must reference a charge line of the same ledger transaction and currency.';
          END IF;
          SELECT COALESCE(SUM(c.amount), 0) INTO line_reversed
            FROM handyman_ledger_corrections c
            WHERE c.correction_kind = 'ADJUSTMENT'
              AND c.source_charge_line_id = NEW.source_charge_line_id;
          IF line_reversed + NEW.amount > line_amount THEN
            RAISE EXCEPTION
              'Handyman adjustment exceeds the charge line amount: a delta never rewrites the underlying line.';
          END IF;
          RETURN NEW;
        END IF;
        SELECT COALESCE(SUM(amount), 0) INTO line_total
          FROM handyman_charge_lines
          WHERE transaction_id = NEW.transaction_id;
        SELECT COALESCE(SUM(c.amount), 0) INTO line_reversed
          FROM handyman_ledger_corrections c
          WHERE c.correction_kind = 'ADJUSTMENT'
            AND c.source_kind = 'TRANSACTION'
            AND c.transaction_id = NEW.transaction_id;
        IF line_reversed + NEW.amount > line_total THEN
          RAISE EXCEPTION
            'Handyman adjustment exceeds the total charge of the ledger transaction.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_ledger_correction_guard_trigger
        BEFORE INSERT OR UPDATE OR DELETE
        ON handyman_ledger_corrections
        FOR EACH ROW
        EXECUTE FUNCTION handyman_ledger_correction_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_ledger_correction_guard_trigger
        ON handyman_ledger_corrections
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS handyman_ledger_correction_guard()
    `);
    await client.query(`DROP TABLE IF EXISTS handyman_ledger_corrections`);
    await client.query(`
      ALTER TABLE handyman_payment_allocations
        DROP CONSTRAINT IF EXISTS
          handyman_payment_allocations_id_transaction_unique
    `);
  },
};

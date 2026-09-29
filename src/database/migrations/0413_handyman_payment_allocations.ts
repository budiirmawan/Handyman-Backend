import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-13 PART 04 — PAYMENT ALLOCATION (FROZEN governance
 * `CR-HM-13_START_GOVERNANCE.md` §6/§8/§9/§10, §13 row 04).
 *
 * ONE new table inside CR-HM-13's ledger boundary:
 * `handyman_payment_allocations` — the append-only fact that binds
 * received funds to ONE immutable charge line. Allocation is a fact,
 * never a status: `unallocated` and `outstanding` remain DERIVED
 * projections over these rows, so an authored "PAID" state that could
 * disagree with the facts is structurally impossible (§6.6 / I12).
 *
 * Structural laws (DB-enforced):
 *  1. An allocation belongs to EXACTLY ONE ledger transaction, and
 *     both the payment and the charge line must belong to that SAME
 *     transaction — enforced by composite FKs, so cross-transaction
 *     allocation is impossible, not merely refused;
 *  2. ONE currency: the allocation currency is FK-bound to the
 *     transaction's own single currency, and the trigger additionally
 *     requires it to equal BOTH the payment's and the charge line's
 *     currency — no FX exists here (§6.4 / I7 / I8);
 *  3. LABOR/MATERIAL stay separate: each allocation targets exactly
 *     one charge line and carries that line's own `line_kind`; the
 *     trigger requires the kind to equal the charge line's kind, so
 *     an allocation can never span or merge kinds (§4.5 / I13);
 *  4. payment-bounded: Σ allocations of a payment ≤ the payment
 *     amount, at all times (§6.2 / I3);
 *  5. charge-bounded: Σ allocations of a charge line ≤ that line's
 *     amount (§6.3 / I4) — a line is never settled beyond its
 *     governed amount;
 *  6. ONLY a CONFIRMED payment is allocatable: a PENDING claim or a
 *     REJECTED claim can never bind funds (§5.3 — notification is
 *     never authority);
 *  7. allocations are append-only and immutable: UPDATE and DELETE
 *     are refused; corrections are later-PART forward-only facts;
 *  8. single-use idempotency scoped to the transaction
 *     (UNIQUE (transaction_id, idempotency_key)): a replay converges
 *     on the SAME allocation and can never mint a second one (§9).
 *
 * ZERO refund/reversal/adjustment (PART 05), ZERO
 * entitlement/settlement/BM fee, ZERO provider/gateway vocabulary,
 * ZERO SaaS/FM coupling, ZERO HTTP.
 */
export const migration0413HandymanPaymentAllocations: Migration = {
  id: '0413_handyman_payment_allocations',
  async up(client: PoolClient): Promise<void> {
    // ---- Composite-FK prerequisites (additive, no data change) ----
    // Makes "the payment / the charge line belongs to THIS ledger
    // transaction" a foreign-key fact rather than a convention.
    await client.query(`
      ALTER TABLE handyman_customer_payments
        ADD CONSTRAINT handyman_customer_payments_id_transaction_unique
        UNIQUE (id, transaction_id)
    `);
    await client.query(`
      ALTER TABLE handyman_charge_lines
        ADD CONSTRAINT handyman_charge_lines_id_transaction_unique
        UNIQUE (id, transaction_id)
    `);

    // ---- ALLOCATION fact table (append-only) ---------------------
    await client.query(`
      CREATE TABLE handyman_payment_allocations (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL
          REFERENCES clients (id),
        transaction_id       UUID NOT NULL,
        payment_id           UUID NOT NULL,
        charge_line_id       UUID NOT NULL,
        line_kind            TEXT NOT NULL,
        currency             VARCHAR(3) NOT NULL,
        amount               NUMERIC(18, 2) NOT NULL,
        allocated_by_user_id UUID NOT NULL
          REFERENCES users (id),
        idempotency_key      TEXT NOT NULL,
        occurred_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_payment_allocations_transaction_client_fk
          FOREIGN KEY (transaction_id, client_id)
            REFERENCES handyman_customer_transactions (id, client_id),
        CONSTRAINT handyman_payment_allocations_transaction_currency_fk
          FOREIGN KEY (transaction_id, currency)
            REFERENCES handyman_customer_transactions (id, currency),
        CONSTRAINT handyman_payment_allocations_payment_fk
          FOREIGN KEY (payment_id, transaction_id)
            REFERENCES handyman_customer_payments (id, transaction_id),
        CONSTRAINT handyman_payment_allocations_charge_line_fk
          FOREIGN KEY (charge_line_id, transaction_id)
            REFERENCES handyman_charge_lines (id, transaction_id),
        CONSTRAINT handyman_payment_allocations_kind_check
          CHECK (line_kind IN ('LABOR', 'MATERIAL')),
        CONSTRAINT handyman_payment_allocations_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT handyman_payment_allocations_amount_check
          CHECK (amount > 0),
        CONSTRAINT handyman_payment_allocations_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_payment_allocations_key_unique
          UNIQUE (transaction_id, idempotency_key)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_payment_allocations_transaction_idx
        ON handyman_payment_allocations
        (transaction_id, occurred_at, id)
    `);
    await client.query(`
      CREATE INDEX handyman_payment_allocations_payment_idx
        ON handyman_payment_allocations (payment_id, occurred_at, id)
    `);
    await client.query(`
      CREATE INDEX handyman_payment_allocations_charge_line_idx
        ON handyman_payment_allocations (charge_line_id, occurred_at, id)
    `);

    // ---- Allocation invariants -----------------------------------
    // Checked in-database so the invariants hold against EVERY writer,
    // not only the command path. `SUM(amount)` is NUMERIC arithmetic:
    // money never passes through a float here.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_payment_allocation_guard()
      RETURNS trigger AS $$
      DECLARE
        pay_status      TEXT;
        pay_tx          UUID;
        pay_client      UUID;
        pay_currency    VARCHAR(3);
        pay_amount      NUMERIC(18, 2);
        line_tx         UUID;
        line_client     UUID;
        line_kind_own   TEXT;
        line_currency   VARCHAR(3);
        line_amount     NUMERIC(18, 2);
        pay_allocated   NUMERIC(18, 2);
        line_allocated  NUMERIC(18, 2);
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman payment allocations are append-only allocated facts: never deleted.';
        END IF;
        IF TG_OP = 'UPDATE' THEN
          RAISE EXCEPTION
            'Handyman payment allocations are immutable allocated facts: corrections are forward-only facts, never an edit.';
        END IF;

        SELECT status, transaction_id, client_id, currency, amount
          INTO pay_status, pay_tx, pay_client, pay_currency, pay_amount
          FROM handyman_customer_payments
          WHERE id = NEW.payment_id;
        IF pay_client IS NULL THEN
          -- Absent payment falls through to the FK constraint.
          RETURN NEW;
        END IF;
        SELECT transaction_id, client_id, line_kind, currency, amount
          INTO line_tx, line_client, line_kind_own, line_currency,
               line_amount
          FROM handyman_charge_lines
          WHERE id = NEW.charge_line_id;
        IF line_client IS NULL THEN
          -- Absent charge line falls through to the FK constraint.
          RETURN NEW;
        END IF;

        -- ONLY confirmed received funds may be allocated: a recorded
        -- claim (PENDING) or a rejected claim is never authority.
        IF pay_status IS DISTINCT FROM 'CONFIRMED' THEN
          RAISE EXCEPTION
            'Only a CONFIRMED Handyman customer payment may be allocated: a recorded or rejected claim is never received-funds authority.';
        END IF;
        IF pay_tx IS DISTINCT FROM NEW.transaction_id
           OR line_tx IS DISTINCT FROM NEW.transaction_id
           OR pay_client IS DISTINCT FROM NEW.client_id
           OR line_client IS DISTINCT FROM NEW.client_id
        THEN
          RAISE EXCEPTION
            'Handyman payment allocation must stay inside one ledger transaction and client (cross-transaction allocation is forbidden).';
        END IF;
        -- One currency, always: no FX and no implicit rate.
        IF NEW.currency IS DISTINCT FROM pay_currency
           OR NEW.currency IS DISTINCT FROM line_currency
        THEN
          RAISE EXCEPTION
            'Handyman payment allocation currency must equal both the payment and the charge line currency (no conversion, no implicit rate).';
        END IF;
        -- LABOR and MATERIAL stay separate: the allocation carries the
        -- charge line's own kind and never merges kinds.
        IF NEW.line_kind IS DISTINCT FROM line_kind_own THEN
          RAISE EXCEPTION
            'Handyman payment allocation kind must equal the charge line kind: LABOR and MATERIAL allocations stay separate.';
        END IF;

        SELECT COALESCE(SUM(amount), 0) INTO pay_allocated
          FROM handyman_payment_allocations
          WHERE payment_id = NEW.payment_id;
        IF pay_allocated + NEW.amount > pay_amount THEN
          RAISE EXCEPTION
            'Handyman payment allocation exceeds the payment amount: over-allocation is forbidden.';
        END IF;
        SELECT COALESCE(SUM(amount), 0) INTO line_allocated
          FROM handyman_payment_allocations
          WHERE charge_line_id = NEW.charge_line_id;
        IF line_allocated + NEW.amount > line_amount THEN
          RAISE EXCEPTION
            'Handyman payment allocation exceeds the charge line amount: a line is never settled beyond its governed amount.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_payment_allocation_guard_trigger
        BEFORE INSERT OR UPDATE OR DELETE
        ON handyman_payment_allocations
        FOR EACH ROW
        EXECUTE FUNCTION handyman_payment_allocation_guard();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_payment_allocation_guard_trigger
        ON handyman_payment_allocations
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS handyman_payment_allocation_guard()
    `);
    await client.query(`
      DROP TABLE IF EXISTS handyman_payment_allocations
    `);
    await client.query(`
      ALTER TABLE handyman_charge_lines
        DROP CONSTRAINT IF EXISTS
          handyman_charge_lines_id_transaction_unique
    `);
    await client.query(`
      ALTER TABLE handyman_customer_payments
        DROP CONSTRAINT IF EXISTS
          handyman_customer_payments_id_transaction_unique
    `);
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-E2E-LIFECYCLE-01 — net allocation caps after PART 05 reversals.
 *
 * Migration 0413 (CR-HM-13 PART 04) installed the allocation guard with
 * GROSS caps (`SUM(handyman_payment_allocations.amount)`), written
 * before CR-HM-13 PART 05 (migration 0414) introduced forward-only
 * ALLOCATION REVERSAL corrections. The correction service's law is
 * that "a reversed allocation stops counting toward the applied
 * amount", the refund bound nets reversed allocations, and the
 * published PART 06 ledger read derives
 * `applied = allocated - reversedAllocations`. The gross guard (and
 * the matching service caps) were never updated, so reversed funds
 * could never be re-allocated to the correct charge line — the
 * reversal was a one-way trap and the engines disagreed.
 *
 * This additive migration replaces ONLY the two cap computations in
 * `handyman_payment_allocation_guard()` with their net equivalents.
 * Allocation facts remain append-only and immutable; no row, amount,
 * or history is rewritten. Gross fact sums remain available for audit
 * (the PART 04 allocation summary intentionally reports gross facts).
 *
 * Down restores the exact migration-0413 gross-cap function body.
 */
export const migration0447NetHandymanAllocationCaps: Migration = {
  id: '0447_net_handyman_allocation_caps',
  async up(tx: PoolClient): Promise<void> {
    await tx.query(`
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
          RETURN NEW;
        END IF;
        SELECT transaction_id, client_id, line_kind, currency, amount
          INTO line_tx, line_client, line_kind_own, line_currency,
               line_amount
          FROM handyman_charge_lines
          WHERE id = NEW.charge_line_id;
        IF line_client IS NULL THEN
          RETURN NEW;
        END IF;

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
        IF NEW.currency IS DISTINCT FROM pay_currency
           OR NEW.currency IS DISTINCT FROM line_currency
        THEN
          RAISE EXCEPTION
            'Handyman payment allocation currency must equal both the payment and the charge line currency (no conversion, no implicit rate).';
        END IF;
        IF NEW.line_kind IS DISTINCT FROM line_kind_own THEN
          RAISE EXCEPTION
            'Handyman payment allocation kind must equal the charge line kind: LABOR and MATERIAL allocations stay separate.';
        END IF;

        -- Net caps (CR-HM-E2E-LIFECYCLE-01): allocations negated by a
        -- PART 05 ALLOCATION REVERSAL correction no longer count
        -- toward the applied amount, exactly as the correction
        -- service, the refund bound, and the PART 06 ledger read
        -- already derive. Gross facts are never rewritten.
        SELECT COALESCE(SUM(amount), 0) INTO pay_allocated
          FROM handyman_payment_allocations
          WHERE payment_id = NEW.payment_id;
        SELECT pay_allocated - COALESCE(SUM(c.amount), 0)
          INTO pay_allocated
          FROM handyman_ledger_corrections c
          JOIN handyman_payment_allocations a
            ON a.id = c.source_allocation_id
          WHERE a.payment_id = NEW.payment_id
            AND c.correction_kind = 'REVERSAL'
            AND c.source_kind = 'ALLOCATION';
        IF pay_allocated + NEW.amount > pay_amount THEN
          RAISE EXCEPTION
            'Handyman payment allocation exceeds the payment amount: over-allocation is forbidden.';
        END IF;
        SELECT COALESCE(SUM(amount), 0) INTO line_allocated
          FROM handyman_payment_allocations
          WHERE charge_line_id = NEW.charge_line_id;
        SELECT line_allocated - COALESCE(SUM(c.amount), 0)
          INTO line_allocated
          FROM handyman_ledger_corrections c
          JOIN handyman_payment_allocations a
            ON a.id = c.source_allocation_id
          WHERE a.charge_line_id = NEW.charge_line_id
            AND c.correction_kind = 'REVERSAL'
            AND c.source_kind = 'ALLOCATION';
        IF line_allocated + NEW.amount > line_amount THEN
          RAISE EXCEPTION
            'Handyman payment allocation exceeds the charge line amount: a line is never settled beyond its governed amount.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
  },

  async down(tx: PoolClient): Promise<void> {
    // Restore the exact migration-0413 gross-cap function body.
    await tx.query(`
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
          RETURN NEW;
        END IF;
        SELECT transaction_id, client_id, line_kind, currency, amount
          INTO line_tx, line_client, line_kind_own, line_currency,
               line_amount
          FROM handyman_charge_lines
          WHERE id = NEW.charge_line_id;
        IF line_client IS NULL THEN
          RETURN NEW;
        END IF;

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
        IF NEW.currency IS DISTINCT FROM pay_currency
           OR NEW.currency IS DISTINCT FROM line_currency
        THEN
          RAISE EXCEPTION
            'Handyman payment allocation currency must equal both the payment and the charge line currency (no conversion, no implicit rate).';
        END IF;
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
  },
};

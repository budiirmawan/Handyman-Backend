import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-13 PART 03 — PAYMENT + PROVIDER-NEUTRAL BOUNDARY (FROZEN
 * governance `CR-HM-13_START_GOVERNANCE.md` §5/§8/§9/§10, §13 row 03).
 *
 * TWO tables, both inside CR-HM-13's ledger boundary:
 *
 * 1. `handyman_customer_payments` — the payment fact. The ledger is
 *    the SOLE authority for received-funds facts (§5). A row is
 *    recorded as `PENDING` and only an explicit, bounded, replay-safe
 *    server-side confirmation makes it authoritative (`CONFIRMED`);
 *    `REJECTED` is the bounded terminal outcome of an unconfirmable
 *    claim. NOTIFICATION IS NEVER AUTHORITY: nothing outside this
 *    table and this path can assert that a payment happened.
 *
 * 2. `handyman_customer_payment_events` — append-only lifecycle
 *    evidence with single-use idempotency
 *    (`UNIQUE (payment_id, event_type, idempotency_key)`).
 *
 * Provider-neutral boundary (§5.1/§5.2):
 *   - the channel vocabulary is a CLOSED set of neutral rails
 *     (CASH, BANK_TRANSFER, VIRTUAL_ACCOUNT, QRIS, CARD, OTHER);
 *   - provider name / provider reference / external reference are
 *     BOUNDED FREE TEXT (1–200 chars) — no provider enum, no
 *     provider-hosted object, no gateway status vocabulary, no
 *     gateway fee/settlement/payout state, and no provider SDK or
 *     adapter exists anywhere in this migration or module;
 *   - external reference, where present, is UNIQUE per transaction
 *     (fail-closed duplicate convergence), per §5.5.
 *
 * Money/currency law: amounts are NUMERIC(18,2) with `amount > 0`
 * (direction is carried by the fact kind — a payment is a positive
 * received-funds fact) and the currency is FK-bound to the
 * transaction's own single currency: cross-currency payment is
 * structurally impossible and no FX exists here (§6.4/I7/I8).
 *
 * Immutability law (§7.1/I1): the money and identity facts are frozen
 * forever. The ONLY permitted mutation is the one-way confirmation
 * projection (PENDING -> CONFIRMED | REJECTED) — every other UPDATE
 * and every DELETE is refused; the authored status can never
 * contradict its own decision columns (I12).
 *
 * ZERO allocation (PART 04), ZERO refund/reversal/adjustment
 * (PART 05), ZERO entitlement/settlement/BM fee, ZERO HTTP.
 */
export const migration0412CreateHandymanCustomerPayments: Migration = {
  id: '0412_create_handyman_customer_payments',
  async up(client: PoolClient): Promise<void> {
    // ---- PAYMENT fact row ----------------------------------------
    await client.query(`
      CREATE TABLE handyman_customer_payments (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL
          REFERENCES clients (id),
        transaction_id       UUID NOT NULL,
        status               TEXT NOT NULL DEFAULT 'PENDING',
        amount               NUMERIC(18, 2) NOT NULL,
        currency             VARCHAR(3) NOT NULL,
        channel              TEXT NOT NULL,
        provider_name        VARCHAR(200),
        provider_reference   VARCHAR(200),
        external_reference   VARCHAR(200),
        received_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        recorded_by_user_id  UUID NOT NULL
          REFERENCES users (id),
        decided_at           TIMESTAMPTZ,
        decided_by_user_id   UUID
          REFERENCES users (id),
        rejection_reason     VARCHAR(200),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_customer_payments_transaction_client_fk
          FOREIGN KEY (transaction_id, client_id)
            REFERENCES handyman_customer_transactions (id, client_id),
        CONSTRAINT handyman_customer_payments_transaction_currency_fk
          FOREIGN KEY (transaction_id, currency)
            REFERENCES handyman_customer_transactions (id, currency),
        CONSTRAINT handyman_customer_payments_status_check
          CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED')),
        CONSTRAINT handyman_customer_payments_amount_check
          CHECK (amount > 0),
        CONSTRAINT handyman_customer_payments_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT handyman_customer_payments_channel_check
          CHECK (channel IN (
            'CASH', 'BANK_TRANSFER', 'VIRTUAL_ACCOUNT', 'QRIS',
            'CARD', 'OTHER')),
        CONSTRAINT handyman_customer_payments_provider_name_check
          CHECK (provider_name IS NULL
            OR char_length(btrim(provider_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_customer_payments_provider_ref_check
          CHECK (provider_reference IS NULL
            OR char_length(btrim(provider_reference)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_customer_payments_external_ref_check
          CHECK (external_reference IS NULL
            OR char_length(btrim(external_reference)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_customer_payments_reason_check
          CHECK (rejection_reason IS NULL
            OR char_length(btrim(rejection_reason)) BETWEEN 1 AND 200),
        -- Authored status can never contradict its decision facts.
        CONSTRAINT handyman_customer_payments_decision_check
          CHECK (
            (status = 'PENDING'
              AND decided_at IS NULL
              AND decided_by_user_id IS NULL
              AND rejection_reason IS NULL)
            OR (status = 'CONFIRMED'
              AND decided_at IS NOT NULL
              AND decided_by_user_id IS NOT NULL
              AND rejection_reason IS NULL)
            OR (status = 'REJECTED'
              AND decided_at IS NOT NULL
              AND decided_by_user_id IS NOT NULL
              AND rejection_reason IS NOT NULL))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_customer_payments_transaction_idx
        ON handyman_customer_payments
        (transaction_id, received_at, id)
    `);
    // External reference uniqueness is PER TRANSACTION and applies
    // only where a reference actually exists (§5.5, fail-closed).
    await client.query(`
      CREATE UNIQUE INDEX handyman_customer_payments_external_ref_idx
        ON handyman_customer_payments (transaction_id, external_reference)
        WHERE external_reference IS NOT NULL
    `);

    // ---- PAYMENT event stream (append-only) ----------------------
    await client.query(`
      CREATE TABLE handyman_customer_payment_events (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL
          REFERENCES clients (id),
        payment_id        UUID NOT NULL
          REFERENCES handyman_customer_payments (id),
        transaction_id    UUID NOT NULL,
        event_type        TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL,
        actor_user_id     UUID NOT NULL
          REFERENCES users (id),
        occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_customer_payment_events_type_check
          CHECK (event_type IN (
            'RECORD_PAYMENT', 'CONFIRM_PAYMENT', 'REJECT_PAYMENT')),
        CONSTRAINT handyman_customer_payment_events_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200)
      )
    `);
    // Single-use idempotency law (§9.1): one key is spent once per
    // transaction and event type, so a replayed request converges on
    // the SAME payment and can never mint a second one.
    await client.query(`
      CREATE UNIQUE INDEX handyman_customer_payment_events_idem_idx
        ON handyman_customer_payment_events
        (transaction_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_customer_payment_events_tx_idx
        ON handyman_customer_payment_events
        (transaction_id, occurred_at, id)
    `);

    // ---- Payment entry state + frozen facts ----------------------
    // A payment is RECORDED as PENDING or not at all; its money and
    // identity facts are frozen forever; its ONLY lawful mutation is
    // the one-way PENDING -> CONFIRMED | REJECTED confirmation
    // projection. DELETE is refused: financial history is immutable.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_customer_payment_guard_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman customer payments are immutable ledger facts: never deleted.';
        END IF;
        IF TG_OP = 'INSERT' THEN
          IF NEW.status IS DISTINCT FROM 'PENDING'
             OR NEW.decided_at IS NOT NULL
             OR NEW.decided_by_user_id IS NOT NULL
             OR NEW.rejection_reason IS NOT NULL
          THEN
            RAISE EXCEPTION
              'Handyman customer payments enter the ledger as PENDING: only the bounded confirmation path may decide them.';
          END IF;
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM OLD.client_id
           OR NEW.transaction_id IS DISTINCT FROM OLD.transaction_id
           OR NEW.amount IS DISTINCT FROM OLD.amount
           OR NEW.currency IS DISTINCT FROM OLD.currency
           OR NEW.channel IS DISTINCT FROM OLD.channel
           OR NEW.provider_name IS DISTINCT FROM OLD.provider_name
           OR NEW.provider_reference IS DISTINCT FROM OLD.provider_reference
           OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
           OR NEW.received_at IS DISTINCT FROM OLD.received_at
           OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
        THEN
          RAISE EXCEPTION
            'Handyman customer payment money and identity facts are immutable once recorded.';
        END IF;
        IF OLD.status IS DISTINCT FROM 'PENDING' THEN
          RAISE EXCEPTION
            'Handyman customer payment is already decided: a second decision is forbidden (one authoritative transition per fact).';
        END IF;
        IF NEW.status IS NULL
           OR NEW.status NOT IN ('CONFIRMED', 'REJECTED')
        THEN
          RAISE EXCEPTION
            'Handyman customer payment decision must be CONFIRMED or REJECTED.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_customer_payment_guard
        BEFORE INSERT OR UPDATE OR DELETE
        ON handyman_customer_payments
        FOR EACH ROW
        EXECUTE FUNCTION handyman_customer_payment_guard_mutation();
    `);

    // ---- Event child consistency ---------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_customer_payment_event_consistency()
      RETURNS trigger AS $$
      DECLARE
        parent_client      UUID;
        parent_transaction UUID;
      BEGIN
        SELECT client_id, transaction_id
          INTO parent_client, parent_transaction
          FROM handyman_customer_payments
          WHERE id = NEW.payment_id;
        IF parent_client IS NULL THEN
          -- Absent parent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM parent_client
           OR NEW.transaction_id IS DISTINCT FROM parent_transaction
        THEN
          RAISE EXCEPTION
            'Handyman customer payment event must share the parent payment client and transaction (cross-ledger binding is forbidden).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_customer_payment_event_child_check
        BEFORE INSERT OR UPDATE ON handyman_customer_payment_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_customer_payment_event_consistency();
    `);

    // ---- Events are append-only ----------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_customer_payment_event_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman customer payment events are append-only: never updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_customer_payment_event_immutable
        BEFORE UPDATE OR DELETE ON handyman_customer_payment_events
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_customer_payment_event_block_mutation();
    `);

    // ---- Every payment and every decision is event-backed --------
    // Deferred to COMMIT so the events may be written right after the
    // row inside one transaction. A payment fact can never become
    // durable without its RECORD_PAYMENT evidence, and a DECIDED
    // payment can never become durable without its matching decision
    // event — a raw SQL decision that skips the confirmation path is
    // therefore structurally impossible (ledger-authoritative law).
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_customer_payment_require_event()
      RETURNS trigger AS $$
      DECLARE
        expected TEXT;
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM handyman_customer_payment_events
          WHERE payment_id = NEW.id
        ) THEN
          RAISE EXCEPTION
            'Handyman customer payments require lifecycle evidence: a payment fact can never be recorded without its RECORD_PAYMENT event.';
        END IF;
        IF NEW.status IS DISTINCT FROM 'PENDING' THEN
          expected := CASE NEW.status
            WHEN 'CONFIRMED' THEN 'CONFIRM_PAYMENT'
            ELSE 'REJECT_PAYMENT'
          END;
          IF NOT EXISTS (
            SELECT 1 FROM handyman_customer_payment_events
            WHERE payment_id = NEW.id AND event_type = expected
          ) THEN
            RAISE EXCEPTION
              'Handyman customer payment decisions require lifecycle evidence: a payment can never be decided without its matching decision event.';
          END IF;
        END IF;
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE CONSTRAINT TRIGGER handyman_customer_payment_event_required
        AFTER INSERT OR UPDATE ON handyman_customer_payments
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW
        EXECUTE FUNCTION handyman_customer_payment_require_event();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_customer_payment_event_required
        ON handyman_customer_payments
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS handyman_customer_payment_require_event()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_customer_payment_event_immutable
        ON handyman_customer_payment_events
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_customer_payment_event_block_mutation()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_customer_payment_event_child_check
        ON handyman_customer_payment_events
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_customer_payment_event_consistency()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_customer_payment_guard
        ON handyman_customer_payments
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS handyman_customer_payment_guard_mutation()
    `);
    await client.query(`
      DROP TABLE IF EXISTS handyman_customer_payment_events
    `);
    await client.query(`
      DROP TABLE IF EXISTS handyman_customer_payments
    `);
  },
};

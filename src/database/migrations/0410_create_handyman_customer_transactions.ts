import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-13 PART 01 — Customer transaction + charge-line FOUNDATION ONLY
 * (FROZEN governance `CR-HM-13_START_GOVERNANCE.md` §3/§4/§8/§9/§10/§13
 * row 01).
 *
 * THREE tables: the customer transaction anchor (exactly ONE per
 * CR-HM-06 Execution Scope), the immutable charge-line ledger, and the
 * append-only transaction event stream. NO charge composition (PART 02),
 * NO payment/allocation (PART 03/04), NO refund/reversal/adjustment
 * (PART 05), NO provider reference, NO entitlement/settlement, NO
 * HTTP/OpenAPI. ZERO SaaS/FM coupling: no FK, no read, no write.
 *
 * Invariants (DB-enforced):
 *   1. The transaction anchors to exactly ONE Execution Scope
 *      (UNIQUE execution_scope_id — governance §4.2 / I9) and its
 *      client/quotation_version must equal the scope's own
 *      client/approved_quotation_version_id (consistency trigger);
 *   2. One currency per transaction (frozen 9-currency list); charge
 *      lines bind to that currency through a composite FK — cross-
 *      currency posting is structurally impossible (§6.4 / I8);
 *   3. Transaction and charge-line rows are IMMUTABLE FACTS: UPDATE and
 *      DELETE are blocked for both tables (I1); corrections are
 *      forward-only facts owned by a later PART (§7);
 *   4. A charge line's commercial facts are the immutable CR-HM-06
 *      quotation snapshot's: the basis trigger requires the referenced
 *      quotation line to live on the transaction's anchored version and
 *      its line_type / line_total / currency to EQUAL the posted
 *      line_kind / amount / currency. The caller can never supply an
 *      amount (§4.3, §4.7);
 *   5. line_kind vocabulary is CLOSED at LABOR / MATERIAL — exactly the
 *      CR-HM-06 quotation line types (§4.4). No third kind exists and
 *      none may be invented here;
 *   6. exact UNIQUE (transaction_id, quotation_line_id): one charge
 *      line per quotation line — posting is never doubled (§4.6);
 *   7. events are append-only: exactly two event types, per-transaction
 *      single-use idempotency
 *      UNIQUE (transaction_id, event_type, idempotency_key) (§9), and
 *      child consistency (client + parent linkage) enforced.
 *
 * Firewall: ZERO payment/allocation/refund/reversal/adjustment/provider/
 * gateway/settlement/invoice/subscription/entitlement column exists on
 * any of the three tables.
 */
export const migration0410CreateHandymanCustomerTransactions: Migration = {
  id: '0410_create_handyman_customer_transactions',
  async up(client: PoolClient): Promise<void> {
    // ---- TRANSACTION anchor (one per Execution Scope) ------------
    await client.query(`
      CREATE TABLE handyman_customer_transactions (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL
          REFERENCES clients (id),
        execution_scope_id   UUID NOT NULL
          REFERENCES handyman_execution_scopes (id),
        quotation_version_id UUID NOT NULL
          REFERENCES handyman_quotation_versions (id),
        currency             VARCHAR(3) NOT NULL,
        created_by_user_id   UUID NOT NULL
          REFERENCES users (id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_customer_transactions_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT handyman_customer_transactions_scope_unique
          UNIQUE (execution_scope_id),
        CONSTRAINT handyman_customer_transactions_id_client_unique
          UNIQUE (id, client_id),
        CONSTRAINT handyman_customer_transactions_id_currency_unique
          UNIQUE (id, currency)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_customer_transactions_client_idx
        ON handyman_customer_transactions (client_id, created_at, id)
    `);

    // ---- CHARGE LINE ledger (immutable, snapshot-anchored) -------
    await client.query(`
      CREATE TABLE handyman_charge_lines (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL
          REFERENCES clients (id),
        transaction_id     UUID NOT NULL,
        quotation_line_id  UUID NOT NULL
          REFERENCES handyman_quotation_lines (id),
        line_kind          TEXT NOT NULL,
        currency           VARCHAR(3) NOT NULL,
        amount             NUMERIC(18, 2) NOT NULL,
        created_by_user_id UUID NOT NULL
          REFERENCES users (id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_charge_lines_transaction_client_fk
          FOREIGN KEY (transaction_id, client_id)
            REFERENCES handyman_customer_transactions (id, client_id),
        CONSTRAINT handyman_charge_lines_transaction_currency_fk
          FOREIGN KEY (transaction_id, currency)
            REFERENCES handyman_customer_transactions (id, currency),
        CONSTRAINT handyman_charge_lines_kind_check
          CHECK (line_kind IN ('LABOR', 'MATERIAL')),
        CONSTRAINT handyman_charge_lines_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT handyman_charge_lines_amount_check
          CHECK (amount >= 0),
        CONSTRAINT handyman_charge_lines_quotation_line_unique
          UNIQUE (transaction_id, quotation_line_id)
      )
    `);
    await client.query(`
      CREATE INDEX handyman_charge_lines_transaction_idx
        ON handyman_charge_lines (transaction_id, created_at, id)
    `);

    // ---- TRANSACTION event stream (append-only) ------------------
    await client.query(`
      CREATE TABLE handyman_customer_transaction_events (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL
          REFERENCES clients (id),
        transaction_id    UUID NOT NULL
          REFERENCES handyman_customer_transactions (id),
        charge_line_id    UUID
          REFERENCES handyman_charge_lines (id),
        event_type        TEXT NOT NULL,
        idempotency_key   TEXT NOT NULL,
        actor_user_id     UUID NOT NULL
          REFERENCES users (id),
        occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_customer_transaction_events_type_check
          CHECK (event_type IN ('OPEN_TRANSACTION', 'POST_CHARGE_LINE')),
        CONSTRAINT handyman_customer_transaction_events_key_check
          CHECK (char_length(btrim(idempotency_key)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_customer_transaction_events_line_check
          CHECK (event_type <> 'POST_CHARGE_LINE'
                   OR charge_line_id IS NOT NULL),
        CONSTRAINT handyman_customer_transaction_events_open_check
          CHECK (event_type <> 'OPEN_TRANSACTION'
                   OR charge_line_id IS NULL)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_customer_transaction_events_idem_idx
        ON handyman_customer_transaction_events
        (transaction_id, event_type, idempotency_key)
    `);
    await client.query(`
      CREATE INDEX handyman_customer_transaction_events_tx_idx
        ON handyman_customer_transaction_events
        (transaction_id, occurred_at, id)
    `);

    // ---- Transaction consistency (scope anchor, server-derived) --
    // client_id and quotation_version_id are NEVER caller-supplied:
    // they must equal the Execution Scope's own client and its
    // immutable approved quotation version (governance §3, I11).
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_customer_transaction_scope_consistency()
      RETURNS trigger AS $$
      DECLARE
        scope_client  UUID;
        scope_version UUID;
      BEGIN
        SELECT client_id, approved_quotation_version_id
          INTO scope_client, scope_version
          FROM handyman_execution_scopes
          WHERE id = NEW.execution_scope_id;
        IF scope_client IS NULL THEN
          -- Absent referent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM scope_client THEN
          RAISE EXCEPTION
            'Handyman customer transaction client_id must match the execution scope client (cross-client binding is forbidden).';
        END IF;
        IF NEW.quotation_version_id IS DISTINCT FROM scope_version THEN
          RAISE EXCEPTION
            'Handyman customer transaction must anchor to the execution scope approved quotation version.';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_customer_transaction_scope_check
        BEFORE INSERT OR UPDATE ON handyman_customer_transactions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_customer_transaction_scope_consistency();
    `);

    // ---- Transaction immutability (posted fact, history forever) --
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_customer_transaction_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman customer transactions are immutable ledger anchors: a correction is a new forward-only fact, never an edit.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_customer_transaction_immutable
        BEFORE UPDATE OR DELETE ON handyman_customer_transactions
        FOR EACH ROW
        EXECUTE FUNCTION handyman_customer_transaction_block_mutation();
    `);

    // ---- Charge-line basis consistency (snapshot is authority) ---
    // The posted commercial facts must EQUAL the immutable CR-HM-06
    // quotation snapshot line on the transaction's anchored version:
    // no caller amount, no repricing, no kind drift, no currency drift.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_charge_line_basis_consistency()
      RETURNS trigger AS $$
      DECLARE
        tx_version      UUID;
        tx_currency     VARCHAR(3);
        quote_version   UUID;
        quote_type      TEXT;
        quote_total     NUMERIC(18, 2);
        quote_currency  VARCHAR(3);
      BEGIN
        SELECT quotation_version_id, currency
          INTO tx_version, tx_currency
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
           OR NEW.amount IS DISTINCT FROM quote_total
           OR NEW.currency IS DISTINCT FROM quote_currency THEN
          RAISE EXCEPTION
            'Handyman charge line commercial facts must equal the immutable quotation snapshot line (amount/kind/currency are never caller-supplied).';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_charge_line_basis_check
        BEFORE INSERT OR UPDATE ON handyman_charge_lines
        FOR EACH ROW
        EXECUTE FUNCTION handyman_charge_line_basis_consistency();
    `);

    // ---- Charge-line immutability (charges are facts) ------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_charge_line_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman charge lines are immutable posted facts: history is corrected by adding forward-only facts, never by update or delete.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_charge_line_immutable
        BEFORE UPDATE OR DELETE ON handyman_charge_lines
        FOR EACH ROW
        EXECUTE FUNCTION handyman_charge_line_block_mutation();
    `);

    // ---- Event child consistency --------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_customer_transaction_event_consistency()
      RETURNS trigger AS $$
      DECLARE
        parent_client UUID;
        line_tx       UUID;
      BEGIN
        SELECT client_id INTO parent_client
          FROM handyman_customer_transactions
          WHERE id = NEW.transaction_id;
        IF parent_client IS NULL THEN
          -- Absent parent falls through to the FK constraint.
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM parent_client THEN
          RAISE EXCEPTION
            'Handyman customer transaction event must share the transaction client (cross-client binding is forbidden).';
        END IF;
        IF NEW.charge_line_id IS NOT NULL THEN
          SELECT transaction_id INTO line_tx
            FROM handyman_charge_lines
            WHERE id = NEW.charge_line_id;
          IF line_tx IS NOT NULL
             AND line_tx IS DISTINCT FROM NEW.transaction_id THEN
            RAISE EXCEPTION
              'Handyman customer transaction event charge line must belong to the same transaction.';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_customer_transaction_event_child_check
        BEFORE INSERT OR UPDATE ON handyman_customer_transaction_events
        FOR EACH ROW
        EXECUTE FUNCTION handyman_customer_transaction_event_consistency();
    `);

    // ---- Event append-only --------------------------------------
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_customer_transaction_event_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman customer transaction events are append-only: never updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_customer_transaction_event_immutable
        BEFORE UPDATE OR DELETE ON handyman_customer_transaction_events
        FOR EACH ROW
        EXECUTE FUNCTION
          handyman_customer_transaction_event_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS
        handyman_customer_transaction_event_immutable
        ON handyman_customer_transaction_events
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_customer_transaction_event_block_mutation()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS
        handyman_customer_transaction_event_child_check
        ON handyman_customer_transaction_events
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_customer_transaction_event_consistency()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_charge_line_immutable
        ON handyman_charge_lines
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS handyman_charge_line_block_mutation()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_charge_line_basis_check
        ON handyman_charge_lines
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS handyman_charge_line_basis_consistency()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_customer_transaction_immutable
        ON handyman_customer_transactions
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_customer_transaction_block_mutation()
    `);
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_customer_transaction_scope_check
        ON handyman_customer_transactions
    `);
    await client.query(`
      DROP FUNCTION IF EXISTS
        handyman_customer_transaction_scope_consistency()
    `);
    await client.query(`
      DROP TABLE IF EXISTS handyman_customer_transaction_events
    `);
    await client.query(`DROP TABLE IF EXISTS handyman_charge_lines`);
    await client.query(`
      DROP TABLE IF EXISTS handyman_customer_transactions
    `);
  },
};

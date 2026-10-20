import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — Bank receipt attestation gap closure.
 *
 * This migration is purely additive and backward-compatible:
 *
 * 1. `handyman_bank_accounts` — configured payment destination bank accounts
 *    per client (optionally building-scoped). Each row represents a trusted
 *    destination account owned by the client. Finance manages them; the
 *    confirmation path validates that the destination account belongs to the
 *    payment's client (and building, when scoped).
 *    - One row per (client_id, bank_name, account_number) is enforced to
 *      prevent duplicate destinations.
 *    - `is_active` gates verification: inactive accounts cannot be used for
 *      new attestations.
 *    - Sensitive account numbers are stored plain for verification but are
 *      masked in read APIs (last 4 only). Operational events never log the
 *      full number.
 *
 * 2. `handyman_bank_receipt_attestations` — immutable, append-only attestation
 *    that Finance creates when verifying a payment. Each attestation is bound
 *    1:1 to a single `handyman_customer_payments` row (UNIQUE payment_id) and
 *    captures:
 *      - destination_bank_account_id (FK to handyman_bank_accounts)
 *      - bank_transaction_id (bank's authoritative reference)
 *      - amount_credited (NUMERIC(18,2), must equal payment amount)
 *      - bank_credited_at (TIMESTAMPTZ, server-validated not in future)
 *      - verified_by_user_id (Finance verifier, from auth context)
 *      - verified_at (TIMESTAMPTZ, DB NOW())
 *      - bank_statement_evidence_ref (optional private reference, 1..500 chars)
 *    - Duplicate bank references are prevented via UNIQUE (client_id, bank_transaction_id)
 *      and UNIQUE (client_id, destination_bank_account_id, bank_transaction_id) is not needed
 *      separately — one global per-client uniqueness suffices to prevent replay.
 *    - The table is append-only: UPDATE and DELETE are blocked via trigger.
 *    - A payment may only transition to CONFIRMED if an attestation row exists
 *      for it. Historical CONFIRMED payments (pre-0459) are grandfathered: they
 *      remain readable without attestations, but new confirmations are gated.
 *
 * 3. Extended `handyman_customer_payments_decision_check` remains unchanged —
 *    CONFIRMED still requires decided_at/decided_by_user_id, but the service
 *    layer now enforces attestation before deciding.
 *
 * Backward compatibility & transition policy:
 *  - Existing CONFIRMED/REJECTED/PENDING payments require NO migration. The new
 *    tables start empty. Existing CONFIRMED rows are grandfathered and remain
 *    authoritative for ledger reads, allocations, invoice status, and FINAL CLOSE.
 *  - New CONFIRM_PAYMENT attempts without a valid attestation are denied with
 *    400 HANDYMAN_BANK_RECEIPT_ATTESTATION_REQUIRED.
 *  - If a client needs to attest historical payments retroactively, Finance may
 *    create attestation rows for old CONFIRMED payments via a manual backfill
 *    (INSERT into handyman_bank_receipt_attestations with verified_by_user_id
 *    = backfill actor, verified_at = NOW(), and the original bank details).
 *    This is optional and does not affect ledger correctness.
 *  - No existing ledger records are rewritten. The ledger's immutability law
 *    (I1) is preserved.
 */
export const migration0459HandymanBankReceiptAttestation: Migration = {
  id: '0459_handyman_bank_receipt_attestation',
  async up(client: PoolClient): Promise<void> {
    // ---- 1. Destination bank accounts (configured payment destinations)
    await client.query(`
      CREATE TABLE handyman_bank_accounts (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID REFERENCES buildings (id),
        bank_name             VARCHAR(100) NOT NULL,
        account_number        VARCHAR(64) NOT NULL,
        account_holder_name   VARCHAR(200) NOT NULL,
        display_name          VARCHAR(200) NOT NULL,
        currency              VARCHAR(3) NOT NULL,
        is_active             BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_bank_accounts_client_fk
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT handyman_bank_accounts_building_client_fk
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT handyman_bank_accounts_bank_name_check
          CHECK (char_length(btrim(bank_name)) BETWEEN 1 AND 100),
        CONSTRAINT handyman_bank_accounts_account_number_check
          CHECK (char_length(btrim(account_number)) BETWEEN 4 AND 64),
        CONSTRAINT handyman_bank_accounts_holder_check
          CHECK (char_length(btrim(account_holder_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_bank_accounts_display_name_check
          CHECK (char_length(btrim(display_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_bank_accounts_currency_check
          CHECK (currency IN ('IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX handyman_bank_accounts_client_account_unique
        ON handyman_bank_accounts (client_id, bank_name, account_number)
    `);

    await client.query(`
      CREATE INDEX handyman_bank_accounts_client_idx
        ON handyman_bank_accounts (client_id, is_active, created_at)
    `);

    await client.query(`
      CREATE INDEX handyman_bank_accounts_building_idx
        ON handyman_bank_accounts (building_id) WHERE building_id IS NOT NULL
    `);

    // Validate building_id belongs to same client as client_id via trigger
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bank_account_building_consistency()
      RETURNS trigger AS $$
      DECLARE
        building_client UUID;
      BEGIN
        IF NEW.building_id IS NULL THEN
          RETURN NEW;
        END IF;
        SELECT p.client_id INTO building_client
          FROM buildings b
          JOIN properties p ON p.id = b.property_id
         WHERE b.id = NEW.building_id;
        IF building_client IS NULL THEN
          RETURN NEW;
        END IF;
        IF NEW.client_id IS DISTINCT FROM building_client THEN
          RAISE EXCEPTION 'Handyman bank account building must belong to the same client.'
            USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bank_account_building_check
        BEFORE INSERT OR UPDATE ON handyman_bank_accounts
        FOR EACH ROW EXECUTE FUNCTION handyman_bank_account_building_consistency()
    `);

    // ---- 2. Immutable bank receipt attestations
    await client.query(`
      CREATE TABLE handyman_bank_receipt_attestations (
        id                              UUID PRIMARY KEY,
        client_id                       UUID NOT NULL REFERENCES clients (id),
        transaction_id                  UUID NOT NULL REFERENCES handyman_customer_transactions (id),
        payment_id                      UUID NOT NULL REFERENCES handyman_customer_payments (id),
        destination_bank_account_id     UUID NOT NULL REFERENCES handyman_bank_accounts (id),
        bank_transaction_id             VARCHAR(200) NOT NULL,
        amount_credited                 NUMERIC(18, 2) NOT NULL,
        currency                        VARCHAR(3) NOT NULL,
        bank_credited_at                TIMESTAMPTZ NOT NULL,
        verified_by_user_id             UUID NOT NULL REFERENCES users (id),
        verified_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        bank_statement_evidence_ref     VARCHAR(500),
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_bank_receipt_attestations_payment_unique
          UNIQUE (payment_id),
        CONSTRAINT handyman_bank_receipt_attestations_bank_ref_check
          CHECK (char_length(btrim(bank_transaction_id)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_bank_receipt_attestations_amount_check
          CHECK (amount_credited > 0),
        CONSTRAINT handyman_bank_receipt_attestations_currency_check
          CHECK (currency IN ('IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT handyman_bank_receipt_attestations_evidence_ref_check
          CHECK (bank_statement_evidence_ref IS NULL
                 OR char_length(btrim(bank_statement_evidence_ref)) BETWEEN 1 AND 500),
        CONSTRAINT handyman_bank_receipt_attestations_client_fk
          FOREIGN KEY (transaction_id, client_id)
            REFERENCES handyman_customer_transactions (id, client_id),
        CONSTRAINT handyman_bank_receipt_attestations_payment_client_fk
          FOREIGN KEY (payment_id, transaction_id, client_id)
            REFERENCES handyman_customer_payments (id, transaction_id, client_id)
      )
    `);

    // Prevent duplicate bank references per client (global replay protection)
    await client.query(`
      CREATE UNIQUE INDEX handyman_bank_receipt_attestations_bank_ref_unique
        ON handyman_bank_receipt_attestations (client_id, bank_transaction_id)
    `);

    await client.query(`
      CREATE INDEX handyman_bank_receipt_attestations_transaction_idx
        ON handyman_bank_receipt_attestations (transaction_id, created_at)
    `);

    await client.query(`
      CREATE INDEX handyman_bank_receipt_attestations_account_idx
        ON handyman_bank_receipt_attestations (destination_bank_account_id)
    `);

    await client.query(`
      CREATE INDEX handyman_bank_receipt_attestations_payment_idx
        ON handyman_bank_receipt_attestations (payment_id)
    `);

    // Ensure attestation client matches transaction and payment client
    // and destination account client, and that attestation currency matches
    // payment currency, and bank_credited_at is not in future (checked via trigger).
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bank_receipt_attestation_consistency()
      RETURNS trigger AS $$
      DECLARE
        pay_client    UUID;
        pay_tx        UUID;
        pay_amount    NUMERIC(18,2);
        pay_currency  VARCHAR(3);
        pay_status    TEXT;
        account_client UUID;
        account_currency VARCHAR(3);
        account_active BOOLEAN;
        tx_client     UUID;
      BEGIN
        SELECT p.client_id, p.transaction_id, p.amount, p.currency, p.status
          INTO pay_client, pay_tx, pay_amount, pay_currency, pay_status
          FROM handyman_customer_payments p WHERE p.id = NEW.payment_id;

        IF pay_client IS NULL THEN
          RETURN NEW;
        END IF;

        SELECT t.client_id INTO tx_client
          FROM handyman_customer_transactions t WHERE t.id = NEW.transaction_id;

        SELECT a.client_id, a.currency, a.is_active
          INTO account_client, account_currency, account_active
          FROM handyman_bank_accounts a WHERE a.id = NEW.destination_bank_account_id;

        IF account_client IS NULL THEN
          RETURN NEW;
        END IF;

        IF NEW.client_id IS DISTINCT FROM pay_client
           OR NEW.client_id IS DISTINCT FROM tx_client
           OR NEW.client_id IS DISTINCT FROM account_client THEN
          RAISE EXCEPTION 'Handyman bank receipt attestation client must match payment, transaction, and destination account.'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.transaction_id IS DISTINCT FROM pay_tx THEN
          RAISE EXCEPTION 'Handyman bank receipt attestation transaction must match its payment transaction.'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.currency IS DISTINCT FROM pay_currency
           OR NEW.currency IS DISTINCT FROM account_currency THEN
          RAISE EXCEPTION 'Handyman bank receipt attestation currency must match payment and account currency.'
            USING ERRCODE = '23514';
        END IF;

        IF NOT account_active THEN
          RAISE EXCEPTION 'Handyman bank receipt attestation destination account is not active.'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.amount_credited IS DISTINCT FROM pay_amount THEN
          RAISE EXCEPTION 'Handyman bank receipt attestation credited amount must equal the payment amount.'
            USING ERRCODE = '23514';
        END IF;

        IF NEW.bank_credited_at > NOW() THEN
          RAISE EXCEPTION 'Handyman bank receipt attestation bank credit time cannot be in the future.'
            USING ERRCODE = '23514';
        END IF;

        -- Bank credit must not be absurdly old (5 years) or future; this is a soft guard.
        -- The trigger above already blocks future; very old dates are blocked here to catch bad input.
        IF NEW.bank_credited_at < NOW() - INTERVAL '5 years' THEN
          RAISE EXCEPTION 'Handyman bank receipt attestation bank credit time is too far in the past.'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      CREATE TRIGGER handyman_bank_receipt_attestation_consistency_check
        BEFORE INSERT OR UPDATE ON handyman_bank_receipt_attestations
        FOR EACH ROW EXECUTE FUNCTION handyman_bank_receipt_attestation_consistency()
    `);

    // Immutable: no UPDATE or DELETE
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bank_receipt_attestation_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Handyman bank receipt attestations are immutable: never updated or deleted.';
      END;
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      CREATE TRIGGER handyman_bank_receipt_attestation_no_mutate
        BEFORE UPDATE OR DELETE ON handyman_bank_receipt_attestations
        FOR EACH ROW EXECUTE FUNCTION handyman_bank_receipt_attestation_block_mutation()
    `);

    // Also ensure bank accounts building consistency on update of building_id/currency etc.
    // Account immutability is NOT enforced — accounts can be deactivated but not rewritten for history.
    // We add a simple updated_at trigger.
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_bank_account_touch_updated_at()
      RETURNS trigger AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_bank_account_touch
        BEFORE UPDATE ON handyman_bank_accounts
        FOR EACH ROW EXECUTE FUNCTION handyman_bank_account_touch_updated_at()
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP TRIGGER IF EXISTS handyman_bank_account_touch ON handyman_bank_accounts`);
    await client.query(`DROP FUNCTION IF EXISTS handyman_bank_account_touch_updated_at()`);
    await client.query(`DROP TRIGGER IF EXISTS handyman_bank_receipt_attestation_no_mutate ON handyman_bank_receipt_attestations`);
    await client.query(`DROP FUNCTION IF EXISTS handyman_bank_receipt_attestation_block_mutation()`);
    await client.query(`DROP TRIGGER IF EXISTS handyman_bank_receipt_attestation_consistency_check ON handyman_bank_receipt_attestations`);
    await client.query(`DROP FUNCTION IF EXISTS handyman_bank_receipt_attestation_consistency()`);
    await client.query(`DROP TABLE IF EXISTS handyman_bank_receipt_attestations`);
    await client.query(`DROP TRIGGER IF EXISTS handyman_bank_account_building_check ON handyman_bank_accounts`);
    await client.query(`DROP FUNCTION IF EXISTS handyman_bank_account_building_consistency()`);
    await client.query(`DROP TABLE IF EXISTS handyman_bank_accounts`);
  },
};

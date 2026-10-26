import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01B — the official Handyman document issuer
 * COMPANY BANK ACCOUNT master (the receiving account a Quotation / Invoice /
 * Scope Variation document tells a customer to pay into).
 *
 * SAME SCOPE DECISION as migration 0490: the row belongs to the HANDYMAN
 * SERVICE PROVIDER organisation (`clients.id`), never to a Building
 * (Building-Management) and never to a tenant company. No payment is executed
 * or settled here: this table only states where the issuer asks to be paid.
 *
 * Invariants (DB-enforced, mirroring the 0490 issuer-profile conventions):
 *   1. history-preserving version chain: every row is one `version` of one
 *      logical account (`bank_account_id` = the id of that chain's first row),
 *      UNIQUE (bank_account_id, version). A content change never overwrites:
 *      it INSERTS version+1, so an already-issued document's payment
 *      instructions can always be re-read exactly as they were printed;
 *   2. payment-critical columns (bank code/name, account number, holder,
 *      currency) are immutable history: UPDATE is refused outright and DELETE
 *      is refused outright, so no actor - including SQL - can move money to a
 *      different account by editing a row that a document already cited;
 *   3. a bank account becomes a payment destination ONLY through the lifecycle
 *      contract, and the DB refuses the shortcut: an ACTIVE row must already
 *      carry `verified_at` + `verified_by_user_id` (nothing invents a
 *      completed verification, and an unverified draft can never be flagged as
 *      the default), only the transitions
 *        PENDING_VERIFICATION -> ACTIVE   (recorded verification)
 *        ACTIVE              -> SUSPENDED (explicit deactivation)
 *        SUSPENDED           -> ACTIVE    (re-activation of the SAME verified
 *                                          data: the verification columns must
 *                                          not move)
 *        ACTIVE / PENDING    -> SUPERSEDED (retirement)
 *      are permitted, and each one must record its own timestamp;
 *   4. exactly one DEFAULT ACTIVE receiving account per provider Client per
 *      currency (partial unique index), so a document can resolve one
 *      unambiguous destination per invoice currency while still keeping
 *      several verified accounts on file.
 *
 * `account_number` is sensitive payment data: reads are masked by the API and
 * the value is never written into `operational_events` metadata (the audit
 * journal carries a mask + a canonical payload digest instead). Currency is a
 * real FK into the platform `currencies` reference (migration 0331) - no
 * parallel currency vocabulary is introduced here.
 */
export const migration0491CreateHandymanDocumentIssuerBankAccounts: Migration = {
  id: '0491_create_handyman_document_issuer_bank_accounts',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_document_issuer_bank_accounts (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        bank_account_id         UUID NOT NULL,
        version                 INTEGER NOT NULL,
        bank_code               TEXT NOT NULL,
        bank_name               TEXT NOT NULL,
        account_number          TEXT NOT NULL,
        account_holder_name     TEXT NOT NULL,
        currency                VARCHAR(3) NOT NULL REFERENCES currencies (code),
        status                  TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
        is_default              BOOLEAN NOT NULL DEFAULT FALSE,
        verification_reference  TEXT,
        verified_at             TIMESTAMPTZ,
        verified_by_user_id     UUID REFERENCES users (id),
        deactivated_at          TIMESTAMPTZ,
        superseded_at           TIMESTAMPTZ,
        effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_user_id      UUID NOT NULL REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_doc_bank_account_status_check
          CHECK (
            status IN ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'SUPERSEDED')
          ),
        CONSTRAINT handyman_doc_bank_account_version_check
          CHECK (version >= 1),
        CONSTRAINT handyman_doc_bank_account_bank_code_check
          CHECK (bank_code ~ '^[A-Z][A-Z0-9]{1,15}$'),
        CONSTRAINT handyman_doc_bank_account_bank_name_check
          CHECK (char_length(btrim(bank_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_doc_bank_account_account_number_check
          CHECK (
            account_number ~ '^[A-Za-z0-9-]{4,34}$'
            AND account_number ~ '[0-9]'
          ),
        CONSTRAINT handyman_doc_bank_account_holder_check
          CHECK (char_length(btrim(account_holder_name)) BETWEEN 1 AND 200),
        CONSTRAINT handyman_doc_bank_account_currency_check
          CHECK (currency ~ '^[A-Z]{3}$'),
        CONSTRAINT handyman_doc_bank_account_verification_reference_check
          CHECK (
            verification_reference IS NULL
            OR char_length(btrim(verification_reference)) BETWEEN 3 AND 300
          ),
        -- An ACTIVE row is by definition a verified destination: the
        -- verification cannot be implied, defaulted or back-filled later.
        CONSTRAINT handyman_doc_bank_account_active_verified_check
          CHECK (
            status <> 'ACTIVE'
            OR (verified_at IS NOT NULL AND verified_by_user_id IS NOT NULL)
          ),
        -- A draft that has never been verified can never be flagged default.
        CONSTRAINT handyman_doc_bank_account_pending_unverified_check
          CHECK (
            status <> 'PENDING_VERIFICATION'
            OR (
              verified_at IS NULL
              AND verified_by_user_id IS NULL
              AND is_default = FALSE
            )
          ),
        CONSTRAINT handyman_doc_bank_account_verified_pair_check
          CHECK (
            (verified_at IS NULL AND verified_by_user_id IS NULL)
            OR (verified_at IS NOT NULL AND verified_by_user_id IS NOT NULL)
          ),
        -- Only a live destination can hold the default flag, and retiring one
        -- must be timestamped: no silent drop of the current account.
        CONSTRAINT handyman_doc_bank_account_default_active_check
          CHECK (is_default = FALSE OR status = 'ACTIVE'),
        CONSTRAINT handyman_doc_bank_account_suspended_at_check
          CHECK (status <> 'SUSPENDED' OR deactivated_at IS NOT NULL),
        CONSTRAINT handyman_doc_bank_account_superseded_at_check
          CHECK (status <> 'SUPERSEDED' OR superseded_at IS NOT NULL)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_doc_bank_account_one_default_idx
        ON handyman_document_issuer_bank_accounts (client_id, currency)
        WHERE status = 'ACTIVE' AND is_default
    `);
    await client.query(`
      CREATE UNIQUE INDEX handyman_doc_bank_account_version_idx
        ON handyman_document_issuer_bank_accounts (bank_account_id, version)
    `);
    await client.query(`
      CREATE INDEX handyman_doc_bank_account_chain_idx
        ON handyman_document_issuer_bank_accounts (bank_account_id, version DESC)
    `);
    await client.query(`
      CREATE INDEX handyman_doc_bank_account_client_status_idx
        ON handyman_document_issuer_bank_accounts (client_id, status, currency, version DESC)
    `);
    // Invariants 2 + 3: content columns are frozen and the only permitted
    // writes are the lifecycle projections above.
    await client.query(`
      CREATE OR REPLACE FUNCTION
        handyman_doc_bank_account_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          RAISE EXCEPTION
            'Handyman document issuer bank accounts are history-preserving: rows cannot be deleted.';
        END IF;
        IF NOT (
             NEW.id = OLD.id
         AND NEW.client_id = OLD.client_id
         AND NEW.bank_account_id = OLD.bank_account_id
         AND NEW.version = OLD.version
         AND NEW.bank_code = OLD.bank_code
         AND NEW.bank_name = OLD.bank_name
         AND NEW.account_number = OLD.account_number
         AND NEW.account_holder_name = OLD.account_holder_name
         AND NEW.currency = OLD.currency
         AND NEW.effective_from = OLD.effective_from
         AND NEW.created_by_user_id = OLD.created_by_user_id
         AND NEW.created_at = OLD.created_at
        ) THEN
          RAISE EXCEPTION
            'Handyman document issuer bank account columns are immutable history: a change to bank, account number, holder or currency inserts a new version row.';
        END IF;
        -- Verification: only an unverified draft can be verified, and the act
        -- must name who verified it, when, and against what reference.
        IF OLD.status = 'PENDING_VERIFICATION' AND NEW.status = 'ACTIVE'
           AND NEW.verified_at IS NOT NULL
           AND NEW.verified_by_user_id IS NOT NULL
           AND NEW.verification_reference IS NOT NULL
           AND NEW.verification_reference <> ''
           AND NEW.deactivated_at IS NULL
           AND NEW.superseded_at IS NULL THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'ACTIVE' AND NEW.status = 'SUSPENDED'
           AND NEW.deactivated_at IS NOT NULL
           AND NEW.is_default = FALSE THEN
          RETURN NEW;
        END IF;
        -- Re-activation reuses the ORIGINAL verification: it may not be
        -- re-stamped onto a different person or moment.
        IF OLD.status = 'SUSPENDED' AND NEW.status = 'ACTIVE'
           AND NEW.verified_at = OLD.verified_at
           AND NEW.verified_by_user_id = OLD.verified_by_user_id
           AND NEW.deactivated_at IS NULL
           AND NEW.superseded_at IS NULL THEN
          RETURN NEW;
        END IF;
        IF OLD.status = 'SUPERSEDED' THEN
          RAISE EXCEPTION
            'A retired Handyman document issuer bank account cannot be reopened: verify another version instead.';
        END IF;
        IF NEW.status = 'SUPERSEDED'
           AND NEW.superseded_at IS NOT NULL
           AND NEW.is_default = FALSE THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION
          'Handyman document issuer bank accounts change only through the lifecycle contract: PENDING_VERIFICATION -> ACTIVE, ACTIVE -> SUSPENDED, SUSPENDED -> ACTIVE or retirement to SUPERSEDED.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_doc_bank_account_no_write
        BEFORE UPDATE OR DELETE
        ON handyman_document_issuer_bank_accounts
        FOR EACH ROW
        EXECUTE FUNCTION handyman_doc_bank_account_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_doc_bank_account_no_write
        ON handyman_document_issuer_bank_accounts;
      DROP FUNCTION IF EXISTS
        handyman_doc_bank_account_block_mutation;
      DROP TABLE IF EXISTS handyman_document_issuer_bank_accounts;
    `);
  },
};

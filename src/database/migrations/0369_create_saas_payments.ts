import type { Pool, PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 07 — SaaS Payment & Reconciliation (frozen §15 / §17).
 *
 * Adds three SaaS payment surfaces. ZERO mutation of facility operations
 * (`payment_receipts` → `tenant_invoices`); both economies remain strictly
 * separate (D-separated by foreign-key targets, not by row-flag).
 *
 * Tables:
 *  - saas_payment_records (frozen §15.1)
 *  - saas_payment_allocations (frozen §15.2)
 *  - saas_payment_provider_references (frozen §15.3, append-only)
 *
 * Frozen invariants enforced by schema:
 *  - amount NUMERIC(18,2) > 0 (no zero/negative payments);
 *  - provider_reference unique per provider_type (dedup independent of
 *    HTTP idempotency, per frozen §15.3 + CR §15);
 *  - allocation (payment_id, invoice_id) unique (no double-allocation);
 *  - allocated amount sum constraint via repository (numeric boundary
 *    enforced at service, not DB level — NUMERIC overflow is impossible
 *    within NUMERIC(18,2) and is asserted at commit);
 *  - billing_account_id FK → saas_billing_accounts(id) (PART 06's
 *    canonical billing authority);
 *  - customer_id FK → clients(id) (the SaaS customer);
 *  - currency_code FK → currencies(code) (canonical currency authority
 *    reused; no new currency catalog);
 *  - invoice_id FK → saas_invoices(id) (PART 06's canonical SaaS invoice
 *    authority — explicitly DIFFERENT from tenant_invoices).
 */
export const migration0369CreateSaasPayments: Migration = {
  id: '0369_create_saas_payments',
  async up(pool: Pool | PoolClient): Promise<void> {
    await pool.query(`
      CREATE TABLE saas_payment_records (
        id                   UUID PRIMARY KEY,
        billing_account_id   UUID NOT NULL,
        customer_id          UUID NOT NULL,
        provider_type        TEXT NOT NULL,
        provider_name        TEXT,
        provider_reference   TEXT,
        amount               NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
        currency_code        VARCHAR(3) NOT NULL,
        received_at          TIMESTAMPTZ NOT NULL,
        status               TEXT NOT NULL
          CHECK (status IN ('PENDING', 'RECONCILED', 'REJECTED')),
        rejection_reason     TEXT,
        reconciled_by_user_id UUID,
        reconciled_at        TIMESTAMPTZ,
        external_reference   TEXT,
        version              INTEGER NOT NULL DEFAULT 1,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT saas_payment_records_billing_account_id_fkey
          FOREIGN KEY (billing_account_id) REFERENCES saas_billing_accounts (id),
        CONSTRAINT saas_payment_records_customer_id_fkey
          FOREIGN KEY (customer_id) REFERENCES clients (id),
        CONSTRAINT saas_payment_records_currency_code_fkey
          FOREIGN KEY (currency_code) REFERENCES currencies (code),
        CONSTRAINT saas_payment_records_provider_type_check
          CHECK (provider_type IN (
            'MANUAL_TRANSFER', 'VIRTUAL_ACCOUNT', 'QRIS',
            'CARD', 'PAYMENT_GATEWAY', 'OTHER'
          )),
        CONSTRAINT saas_payment_records_provider_reference_unique
          UNIQUE (provider_type, provider_reference)
      );
    `);

    await pool.query(`
      CREATE INDEX saas_payment_records_billing_account_id_idx
        ON saas_payment_records (billing_account_id);
    `);
    await pool.query(`
      CREATE INDEX saas_payment_records_customer_id_idx
        ON saas_payment_records (customer_id);
    `);
    await pool.query(`
      CREATE INDEX saas_payment_records_status_idx
        ON saas_payment_records (status);
    `);
    await pool.query(`
      CREATE INDEX saas_payment_records_received_at_idx
        ON saas_payment_records (received_at DESC);
    `);

    await pool.query(`
      CREATE TABLE saas_payment_allocations (
        id                  UUID PRIMARY KEY,
        payment_id          UUID NOT NULL,
        invoice_id          UUID NOT NULL,
        customer_id         UUID NOT NULL,
        billing_account_id  UUID NOT NULL,
        amount              NUMERIC(18, 2) NOT NULL CHECK (amount > 0),
        currency_code       VARCHAR(3) NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by_user_id  UUID,

        CONSTRAINT saas_payment_allocations_payment_id_fkey
          FOREIGN KEY (payment_id) REFERENCES saas_payment_records (id),
        CONSTRAINT saas_payment_allocations_invoice_id_fkey
          FOREIGN KEY (invoice_id) REFERENCES saas_invoices (id),
        CONSTRAINT saas_payment_allocations_customer_id_fkey
          FOREIGN KEY (customer_id) REFERENCES clients (id),
        CONSTRAINT saas_payment_allocations_billing_account_id_fkey
          FOREIGN KEY (billing_account_id) REFERENCES saas_billing_accounts (id),
        CONSTRAINT saas_payment_allocations_currency_code_fkey
          FOREIGN KEY (currency_code) REFERENCES currencies (code),
        CONSTRAINT saas_payment_allocations_payment_invoice_unique
          UNIQUE (payment_id, invoice_id)
      );
    `);

    await pool.query(`
      CREATE INDEX saas_payment_allocations_payment_id_idx
        ON saas_payment_allocations (payment_id);
    `);
    await pool.query(`
      CREATE INDEX saas_payment_allocations_invoice_id_idx
        ON saas_payment_allocations (invoice_id);
    `);
    await pool.query(`
      CREATE INDEX saas_payment_allocations_customer_id_idx
        ON saas_payment_allocations (customer_id);
    `);

    await pool.query(`
      CREATE TABLE saas_payment_provider_references (
        id                  UUID PRIMARY KEY,
        payment_id          UUID,
        provider_type       TEXT NOT NULL,
        provider_name       TEXT,
        external_reference  TEXT NOT NULL,
        event_type          TEXT NOT NULL,
        payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
        received_at         TIMESTAMPTZ NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT saas_payment_provider_references_payment_id_fkey
          FOREIGN KEY (payment_id) REFERENCES saas_payment_records (id),
        CONSTRAINT saas_payment_provider_references_provider_type_check
          CHECK (provider_type IN (
            'MANUAL_TRANSFER', 'VIRTUAL_ACCOUNT', 'QRIS',
            'CARD', 'PAYMENT_GATEWAY', 'OTHER'
          ))
      );
    `);

    await pool.query(`
      CREATE INDEX saas_payment_provider_references_payment_id_idx
        ON saas_payment_provider_references (payment_id);
    `);
    await pool.query(`
      CREATE INDEX saas_payment_provider_references_external_reference_idx
        ON saas_payment_provider_references (provider_type, external_reference);
    `);
  },
  async down(): Promise<void> {
    throw new Error(
      'migration0369CreateSaasPayments.down is irreversible by frozen design (D4 — never drop SaaS commercial history).',
    );
  },
};

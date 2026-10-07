import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 06 — SaaS Invoice & Invoice Line foundation.
 *
 * Frozen contract §14.2/§14.3/§14.4: the canonical SaaS subscription
 * billing document (Gatepro → SaaS Customer). A NEW authority — the
 * facility-operations `tenant_invoices` (BE-19D: tenant/space-scoped
 * operational charges) is NOT reused and stays untouched.
 *
 * Historical integrity (frozen §14.3): line amounts are SNAPSHOTS of the
 * bound (historical) pricebook version item — later pricebook
 * publishing/supersession or product/package renames never rewrite an
 * issued invoice. Invoices are immutable once ISSUED (corrections = a new
 * ADJUSTMENT-line invoice or VOID).
 *
 * Monetary convention: NUMERIC(18,2) throughout — no floating point
 * (repository money precedent: saas_price_items, tenant charges).
 *
 * Invoice numbering (frozen §14.2): server-generated `SAAS-YYYY-NNNNNN`,
 * unique, concurrency-safe via the `saas_invoice_number_sequences`
 * per-year counter (row-locked increment inside the caller's
 * transaction). Never caller-authoritative.
 *
 * Line-type vocabulary (frozen §14.3): the full set is stored for
 * future compatibility; PART 06 only GENERATES the types backed by
 * implemented authority (BASE_SUBSCRIPTION, ADDITIONAL_BUILDING).
 * ADD_ON (add-ons not implemented), USAGE (PART 09 metering), DISCOUNT /
 * ADJUSTMENT / TAX (no authorized adjustment/tax rule in PART 06) exist
 * as vocabulary only.
 *
 * Payment boundary (frozen §15/§17): `paid_at` is carried for PART 07
 * (Payment & Reconciliation) and stays NULL in PART 06 — no payment
 * status is faked. PARTIALLY_PAID / PAID / OVERDUE are frozen
 * vocabulary; their transitions are owned by PART 07 / PART 08 and are
 * NOT implemented here.
 */
export const migration0367CreateSaasInvoices: Migration = {
  id: '0367_create_saas_invoices',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE saas_invoices (
        id UUID PRIMARY KEY,
        number TEXT NOT NULL,
        billing_account_id UUID NOT NULL,
        customer_id UUID NOT NULL,
        subscription_id UUID,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        currency_code VARCHAR(3) NOT NULL,
        base_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
        tax_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
        total_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        issued_at TIMESTAMPTZ,
        due_at TIMESTAMPTZ,
        paid_at TIMESTAMPTZ,
        voided_at TIMESTAMPTZ,
        void_reason TEXT,
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_invoices_number_unique UNIQUE (number),
        CONSTRAINT saas_invoices_billing_account_id_fkey
          FOREIGN KEY (billing_account_id) REFERENCES saas_billing_accounts (id),
        CONSTRAINT saas_invoices_customer_id_fkey
          FOREIGN KEY (customer_id) REFERENCES clients (id),
        CONSTRAINT saas_invoices_subscription_id_fkey
          FOREIGN KEY (subscription_id) REFERENCES subscriptions (id),
        CONSTRAINT saas_invoices_currency_code_fkey
          FOREIGN KEY (currency_code) REFERENCES currencies (code),
        CONSTRAINT saas_invoices_status_check
          CHECK (status IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID')),
        CONSTRAINT saas_invoices_amounts_check
          CHECK (base_amount >= 0 AND tax_amount >= 0 AND total_amount >= 0),
        CONSTRAINT saas_invoices_total_check
          CHECK (total_amount = base_amount + tax_amount),
        CONSTRAINT saas_invoices_period_check
          CHECK (period_end > period_start),
        CONSTRAINT saas_invoices_version_check
          CHECK (version >= 1)
      )
    `);
    await client.query(`
      CREATE INDEX saas_invoices_customer_id_idx ON saas_invoices (customer_id);
      CREATE INDEX saas_invoices_subscription_id_idx ON saas_invoices (subscription_id);
      CREATE INDEX saas_invoices_billing_account_id_idx ON saas_invoices (billing_account_id);
      CREATE INDEX saas_invoices_status_idx ON saas_invoices (status);
      CREATE INDEX saas_invoices_period_idx ON saas_invoices (period_start, period_end);
    `);

    await client.query(`
      CREATE TABLE saas_invoice_lines (
        id UUID PRIMARY KEY,
        invoice_id UUID NOT NULL,
        line_type TEXT NOT NULL,
        description TEXT NOT NULL,
        quantity NUMERIC NOT NULL DEFAULT 1,
        unit_amount NUMERIC(18,2) NOT NULL,
        amount NUMERIC(18,2) NOT NULL,
        currency_code VARCHAR(3) NOT NULL,
        reference_type TEXT,
        reference_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_invoice_lines_invoice_id_fkey
          FOREIGN KEY (invoice_id) REFERENCES saas_invoices (id),
        CONSTRAINT saas_invoice_lines_currency_code_fkey
          FOREIGN KEY (currency_code) REFERENCES currencies (code),
        CONSTRAINT saas_invoice_lines_line_type_check
          CHECK (line_type IN ('BASE_SUBSCRIPTION', 'ADDITIONAL_BUILDING', 'ADD_ON',
                               'USAGE', 'DISCOUNT', 'ADJUSTMENT', 'TAX')),
        CONSTRAINT saas_invoice_lines_quantity_check
          CHECK (quantity >= 0)
      )
    `);
    await client.query(
      'CREATE INDEX saas_invoice_lines_invoice_id_idx ON saas_invoice_lines (invoice_id)',
    );

    // Concurrency-safe per-year invoice number counter (frozen §14.2
    // scheme SAAS-YYYY-NNNNNN): the row lock on the year row makes
    // concurrent allocation deterministic.
    await client.query(`
      CREATE TABLE saas_invoice_number_sequences (
        year INT PRIMARY KEY,
        last_number INT NOT NULL DEFAULT 0
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS saas_invoice_number_sequences');
    await client.query('DROP TABLE IF EXISTS saas_invoice_lines');
    await client.query('DROP TABLE IF EXISTS saas_invoices');
  },
};

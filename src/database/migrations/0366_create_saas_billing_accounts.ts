import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 06 — SaaS Billing Account foundation.
 *
 * Frozen contract §14.1: the billing PARTY/TERMS used for SaaS billing
 * documents (Gatepro → SaaS Customer). Distinct from the SaaS Customer
 * (§8, `clients`) — the billing account references it, it does not replace
 * it — and distinct from the facility-operations business-plane billing
 * tables (tenant_invoices / payment_receipts, BE-19) which bill tenants/
 * occupants for operational charges and must NOT become SaaS invoices
 * (frozen §5 seam map: "deliberately not reused").
 *
 * Product-agnostic by design: no product/package/subscription fields are
 * duplicated here — the commercial chain stays Customer → Subscription →
 * Product (frozen §6). Any future Gatepro product profile (Building /
 * Vendor FM / Handyman) bills through the same account model.
 *
 * Cardinality (frozen): a partial unique index keeps at most one ACTIVE
 * account per customer initially, while the schema supports multiple
 * accounts (future multi-billing-relationship without tenant-model
 * change, CR §13).
 */
export const migration0366CreateSaasBillingAccounts: Migration = {
  id: '0366_create_saas_billing_accounts',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE saas_billing_accounts (
        id UUID PRIMARY KEY,
        customer_id UUID NOT NULL,
        legal_name TEXT NOT NULL,
        tax_identity TEXT,
        billing_address JSONB NOT NULL DEFAULT '{}',
        billing_email TEXT,
        currency_code VARCHAR(3) NOT NULL,
        payment_terms INT NOT NULL DEFAULT 30,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_billing_accounts_customer_id_fkey
          FOREIGN KEY (customer_id) REFERENCES clients (id),
        CONSTRAINT saas_billing_accounts_currency_code_fkey
          FOREIGN KEY (currency_code) REFERENCES currencies (code),
        CONSTRAINT saas_billing_accounts_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT saas_billing_accounts_payment_terms_check
          CHECK (payment_terms >= 0),
        CONSTRAINT saas_billing_accounts_version_check
          CHECK (version >= 1)
      )
    `);
    // Frozen §14.1: at most one ACTIVE account per customer initially;
    // the schema keeps multiple accounts possible.
    await client.query(`
      CREATE UNIQUE INDEX saas_billing_accounts_one_active_per_customer
        ON saas_billing_accounts (customer_id)
      WHERE status = 'ACTIVE'
    `);
    await client.query(
      'CREATE INDEX saas_billing_accounts_customer_id_idx ON saas_billing_accounts (customer_id)',
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS saas_billing_accounts');
  },
};

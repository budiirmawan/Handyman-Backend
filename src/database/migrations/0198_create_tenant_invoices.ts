import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-19D — Tenant Invoice.
 *
 * Invoice lines reference BE-19A Tenant Charges or BE-19B Utility Bills. They
 * never copy source descriptions, periods, Meter data, or Tenant data. The
 * amount applied to an invoice is snapshotted because a finalized invoice is
 * an immutable billing fact; draft snapshots are refreshed before finalizing.
 * No payment, tax, ledger, or accounting entries are introduced.
 */
export const migration0198CreateTenantInvoices: Migration = {
  id: '0198_create_tenant_invoices',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_invoices (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL REFERENCES clients (id),
        tenant_company_id    UUID NOT NULL REFERENCES tenant_companies (id),
        building_id          UUID NOT NULL REFERENCES buildings (id),
        space_id             UUID NOT NULL REFERENCES spaces (id),
        invoice_number       TEXT NOT NULL,
        invoice_date         DATE NOT NULL,
        due_date             DATE NOT NULL,
        status               TEXT NOT NULL DEFAULT 'DRAFT',
        subtotal             NUMERIC NOT NULL DEFAULT 0,
        total_amount         NUMERIC NOT NULL DEFAULT 0,
        notes                TEXT,
        created_by_user_id   UUID NOT NULL REFERENCES users (id),
        finalized_at         TIMESTAMPTZ,
        finalized_by_user_id UUID REFERENCES users (id),
        cancelled_at         TIMESTAMPTZ,
        cancelled_by_user_id UUID REFERENCES users (id),
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_invoices_number_unique UNIQUE (client_id, invoice_number),
        CONSTRAINT tenant_invoices_date_check CHECK (due_date >= invoice_date),
        CONSTRAINT tenant_invoices_amount_check
          CHECK (subtotal >= 0 AND total_amount >= 0 AND total_amount = subtotal),
        CONSTRAINT tenant_invoices_status_check
          CHECK (status IN ('DRAFT', 'FINALIZED', 'CANCELLED')),
        CONSTRAINT tenant_invoices_state_check CHECK (
          (status = 'DRAFT' AND finalized_at IS NULL AND finalized_by_user_id IS NULL
                            AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
          OR
          (status = 'FINALIZED' AND finalized_at IS NOT NULL AND finalized_by_user_id IS NOT NULL
                                AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
          OR
          (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE INDEX tenant_invoices_tenant_idx
        ON tenant_invoices (tenant_company_id, invoice_date DESC);
      CREATE INDEX tenant_invoices_building_idx
        ON tenant_invoices (building_id, invoice_date DESC);
      CREATE INDEX tenant_invoices_status_idx
        ON tenant_invoices (status, invoice_date DESC)
    `);

    await client.query(`
      CREATE TABLE tenant_invoice_lines (
        id                UUID PRIMARY KEY,
        invoice_id        UUID NOT NULL REFERENCES tenant_invoices (id),
        source_type       TEXT NOT NULL,
        tenant_charge_id  UUID REFERENCES tenant_charges (id),
        utility_bill_id   UUID REFERENCES utility_bills (id),
        amount_snapshot   NUMERIC NOT NULL,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_invoice_lines_source_type_check
          CHECK (source_type IN ('TENANT_CHARGE', 'UTILITY_BILL')),
        CONSTRAINT tenant_invoice_lines_source_reference_check CHECK (
          (tenant_charge_id IS NOT NULL)::int + (utility_bill_id IS NOT NULL)::int = 1
        ),
        CONSTRAINT tenant_invoice_lines_type_reference_check CHECK (
          (source_type = 'TENANT_CHARGE' AND tenant_charge_id IS NOT NULL)
          OR (source_type = 'UTILITY_BILL' AND utility_bill_id IS NOT NULL)
        ),
        CONSTRAINT tenant_invoice_lines_amount_check CHECK (amount_snapshot >= 0),
        CONSTRAINT tenant_invoice_lines_tenant_charge_unique UNIQUE (tenant_charge_id),
        CONSTRAINT tenant_invoice_lines_utility_bill_unique UNIQUE (utility_bill_id)
      )
    `);
    await client.query('CREATE INDEX tenant_invoice_lines_invoice_idx ON tenant_invoice_lines (invoice_id, created_at)');

    await client.query(`
      CREATE TABLE tenant_invoice_history (
        id                 UUID PRIMARY KEY,
        tenant_invoice_id  UUID NOT NULL REFERENCES tenant_invoices (id),
        action             TEXT NOT NULL,
        invoice_date       DATE NOT NULL,
        due_date           DATE NOT NULL,
        status             TEXT NOT NULL,
        subtotal           NUMERIC NOT NULL,
        total_amount       NUMERIC NOT NULL,
        notes              TEXT,
        changed_by_user_id UUID NOT NULL REFERENCES users (id),
        changed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_invoice_history_action_check
          CHECK (action IN ('CREATED', 'UPDATED', 'LINE_LINKED', 'FINALIZED', 'CANCELLED'))
      )
    `);
    await client.query('CREATE INDEX tenant_invoice_history_invoice_idx ON tenant_invoice_history (tenant_invoice_id, changed_at)');
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_invoice_history');
    await client.query('DROP TABLE IF EXISTS tenant_invoice_lines');
    await client.query('DROP TABLE IF EXISTS tenant_invoices');
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-COM-02 PART 01 — Vendor Invoice authority.
 *
 * Creates `vendor_invoices` and `vendor_invoice_history` tables.
 * Vendor Invoice is the canonical payable invoice from an external Vendor.
 * It is NOT a Tenant Invoice, vendor-service-cost, Purchase Order, or Payment.
 *
 * Lifecycle: DRAFT → FINALIZED → CANCELLED.
 * Invoice number is unique within a Client.
 */
export const migration0261CreateVendorInvoices: Migration = {
  id: '0261_create_vendor_invoices',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_invoices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID NOT NULL REFERENCES buildings (id),
        vendor_id UUID NOT NULL REFERENCES vendors (id),
        invoice_number TEXT NOT NULL,
        invoice_date DATE NOT NULL,
        received_date DATE NOT NULL,
        currency TEXT NOT NULL,
        invoice_amount NUMERIC(18, 2) NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        vendor_reference TEXT,
        vendor_work_id UUID REFERENCES vendor_works (id),
        work_order_id UUID REFERENCES work_orders (id),
        completion_report_id UUID REFERENCES vendor_completion_reports (id),
        service_report_id UUID REFERENCES vendor_service_reports (id),
        bast_document_id UUID REFERENCES bast_documents (id),
        notes TEXT,
        created_by_user_id UUID NOT NULL REFERENCES users (id),
        finalized_at TIMESTAMPTZ,
        finalized_by_user_id UUID REFERENCES users (id),
        cancelled_at TIMESTAMPTZ,
        cancelled_by_user_id UUID REFERENCES users (id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT vendor_invoices_status_check
          CHECK (status IN ('DRAFT', 'FINALIZED', 'CANCELLED')),
        CONSTRAINT vendor_invoices_currency_check
          CHECK (currency IN ('IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY')),
        CONSTRAINT vendor_invoices_amount_non_negative
          CHECK (invoice_amount >= 0),
        CONSTRAINT vendor_invoices_client_number_unique
          UNIQUE (client_id, invoice_number)
      )
    `);

    await client.query(`
      CREATE INDEX vendor_invoices_vendor_idx
        ON vendor_invoices (vendor_id, status)
    `);

    await client.query(`
      CREATE INDEX vendor_invoices_building_idx
        ON vendor_invoices (building_id, status)
    `);

    await client.query(`
      CREATE INDEX vendor_invoices_work_order_idx
        ON vendor_invoices (work_order_id)
        WHERE work_order_id IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX vendor_invoices_vendor_work_idx
        ON vendor_invoices (vendor_work_id)
        WHERE vendor_work_id IS NOT NULL
    `);

    await client.query(`
      CREATE TABLE vendor_invoice_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        vendor_invoice_id UUID NOT NULL REFERENCES vendor_invoices (id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        invoice_date DATE,
        received_date DATE,
        currency TEXT,
        invoice_amount NUMERIC(18, 2),
        status TEXT,
        vendor_reference TEXT,
        notes TEXT,
        changed_by_user_id UUID REFERENCES users (id),
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX vendor_invoice_history_invoice_idx
        ON vendor_invoice_history (vendor_invoice_id, changed_at)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_invoice_history');
    await client.query('DROP TABLE IF EXISTS vendor_invoices');
  },
};

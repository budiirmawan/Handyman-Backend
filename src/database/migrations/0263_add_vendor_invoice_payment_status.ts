import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-COM-02 PART 03 — Vendor Payment Status columns.
 *
 * Adds payment_status, paid_amount, outstanding_amount,
 * and last_payment_date to vendor_invoices.
 *
 * Also extends vendor_invoice_history with payment columns
 * for audit trail.
 */
export const migration0263AddVendorInvoicePaymentStatus: Migration = {
  id: '0263_add_vendor_invoice_payment_status',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE vendor_invoices
        ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'UNPAID',
        ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(18, 2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS outstanding_amount NUMERIC(18, 2) GENERATED ALWAYS AS (invoice_amount - paid_amount) STORED,
        ADD COLUMN IF NOT EXISTS last_payment_date DATE;
    `);

    // Initialize outstanding_amount for existing rows (should be invoice_amount
    // since paid_amount defaults to 0), but GENERATED ALWAYS STORED handles
    // this automatically for new rows. For existing rows where the generated
    // column was just added, PostgreSQL computes it automatically.

    await client.query(`
      CREATE INDEX IF NOT EXISTS vendor_invoices_payment_status_idx
        ON vendor_invoices (payment_status)
        WHERE payment_status IN ('PARTIALLY_PAID', 'PAID');
    `);

    await client.query(`
      ALTER TABLE vendor_invoice_history
        ADD COLUMN IF NOT EXISTS payment_status TEXT,
        ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(18, 2);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS vendor_invoices_payment_status_idx;
    `);

    await client.query(`
      ALTER TABLE vendor_invoices
        DROP COLUMN IF EXISTS outstanding_amount,
        DROP COLUMN IF EXISTS last_payment_date,
        DROP COLUMN IF EXISTS paid_amount,
        DROP COLUMN IF EXISTS payment_status;
    `);

    await client.query(`
      ALTER TABLE vendor_invoice_history
        DROP COLUMN IF EXISTS paid_amount,
        DROP COLUMN IF EXISTS payment_status;
    `);
  },
};

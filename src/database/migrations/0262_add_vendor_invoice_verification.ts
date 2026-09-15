import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-COM-02 PART 02 — Vendor Invoice verification columns.
 *
 * Adds verification_status, verified_by_user_id, verified_at,
 * verification_notes, and discrepancy_codes to vendor_invoices.
 *
 * Also extends vendor_invoice_history with verification columns
 * for audit trail.
 */
export const migration0262AddVendorInvoiceVerification: Migration = {
  id: '0262_add_vendor_invoice_verification',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE vendor_invoices
        ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'PENDING',
        ADD COLUMN IF NOT EXISTS verified_by_user_id UUID REFERENCES users (id),
        ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS verification_notes TEXT,
        ADD COLUMN IF NOT EXISTS discrepancy_codes JSONB NOT NULL DEFAULT '[]'::jsonb;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS vendor_invoices_verification_status_idx
        ON vendor_invoices (verification_status)
        WHERE verification_status IN ('VERIFIED', 'DISCREPANCY');
    `);

    await client.query(`
      ALTER TABLE vendor_invoice_history
        ADD COLUMN IF NOT EXISTS verification_status TEXT,
        ADD COLUMN IF NOT EXISTS discrepancy_codes JSONB;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS vendor_invoices_verification_status_idx;
    `);

    await client.query(`
      ALTER TABLE vendor_invoices
        DROP COLUMN IF EXISTS verification_status,
        DROP COLUMN IF EXISTS verified_by_user_id,
        DROP COLUMN IF EXISTS verified_at,
        DROP COLUMN IF EXISTS verification_notes,
        DROP COLUMN IF EXISTS discrepancy_codes;
    `);

    await client.query(`
      ALTER TABLE vendor_invoice_history
        DROP COLUMN IF EXISTS verification_status,
        DROP COLUMN IF EXISTS discrepancy_codes;
    `);
  },
};

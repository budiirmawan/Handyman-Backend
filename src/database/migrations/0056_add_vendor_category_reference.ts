import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-06B — Optional Vendor → Vendor Category classification reference.
 *
 * `vendor_category_id` is NULLABLE and defaults to NULL, so every existing
 * Vendor (and every Vendor that simply has no classification) remains valid
 * without change. Classification is never mandatory.
 *
 * Client-context integrity (a Vendor may only be classified by a Vendor
 * Category of its own Client) and the inactive-Category rule are business
 * rules enforced by the service layer, where they also yield the proper API
 * errors — the FK here guarantees referential integrity only.
 */
export const migration0056AddVendorCategoryReference: Migration = {
  id: '0056_add_vendor_category_reference',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE vendors
        ADD COLUMN vendor_category_id UUID,
        ADD CONSTRAINT vendors_vendor_category_id_fkey
          FOREIGN KEY (vendor_category_id) REFERENCES vendor_categories (id)
    `);

    await client.query(
      `CREATE INDEX vendors_vendor_category_id_idx
         ON vendors (vendor_category_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE vendors
        DROP CONSTRAINT IF EXISTS vendors_vendor_category_id_fkey,
        DROP COLUMN IF EXISTS vendor_category_id
    `);
  },
};

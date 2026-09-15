import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-06B — Vendor Classification: Vendor Category reference data.
 *
 * A Vendor Category is Client-scoped classification/reference data for
 * Vendors (e.g. ENGINEERING, HOUSEKEEPING, SECURITY, LIFT, HVAC,
 * FIRE_PROTECTION, ELECTRICAL, PLUMBING). Those examples remain DATA — rows
 * created per Client — never hardcoded business logic.
 *
 * Follows the BE-04E `room_types` idiom: `code` unique per Client, an
 * ACTIVE/INACTIVE lifecycle, and no workflow of its own. Deactivating a
 * Category is not a delete: existing Vendor classifications survive; the
 * Category simply stops being assignable to further Vendors (service rule).
 */
export const migration0055CreateVendorCategories: Migration = {
  id: '0055_create_vendor_categories',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_categories (
        id          UUID PRIMARY KEY,
        client_id   UUID NOT NULL,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_categories_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT vendor_categories_client_code_unique
          UNIQUE (client_id, code),
        CONSTRAINT vendor_categories_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX vendor_categories_client_id_idx
         ON vendor_categories (client_id)`,
    );
    await client.query(
      `CREATE INDEX vendor_categories_status_idx
         ON vendor_categories (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_categories');
  },
};

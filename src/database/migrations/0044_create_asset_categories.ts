import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05B — Asset Category foundation.
 *
 * An Asset Category is Client-scoped classification/reference data for Assets
 * (e.g. ELECTRICAL, MECHANICAL, HVAC, FIRE_PROTECTION, LIFT, PLUMBING,
 * SECURITY_SYSTEM). It is a *master/reference* entity only — it is NOT a
 * hierarchy level and NOT an Asset: the registry chain remains
 * Client → Property → Building → Asset, and a Category merely classifies an
 * Asset.
 *
 * Category codes are DATA, not hardcoded application behavior — no
 * application logic may branch on a specific category code. The example
 * categories above are seedable data, never `if (code === 'HVAC')`.
 *
 * Scoping follows the BE-04E Room Type precedent: every Category belongs to
 * exactly one Client, and `code` is unique per Client (`client_id + code`) so
 * two Clients may independently define the same code. Inactive Categories are
 * retained for history rather than hard-deleted.
 */
export const migration0044CreateAssetCategories: Migration = {
  id: '0044_create_asset_categories',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE asset_categories (
        id          UUID PRIMARY KEY,
        client_id   UUID NOT NULL,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT asset_categories_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT asset_categories_client_code_unique UNIQUE (client_id, code),
        CONSTRAINT asset_categories_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX asset_categories_client_id_idx
         ON asset_categories (client_id)`,
    );
    await client.query(
      `CREATE INDEX asset_categories_status_idx ON asset_categories (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS asset_categories');
  },
};

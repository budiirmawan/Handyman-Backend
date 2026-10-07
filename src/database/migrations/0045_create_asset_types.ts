import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05B — Asset Type / Class foundation.
 *
 * An Asset Type is the finer classification level beneath an Asset Category
 * (e.g. HVAC → AHU, CHILLER, FCU; ELECTRICAL → PANEL, GENSET). It always
 * belongs to exactly one Category, and Client ownership is derived
 * authoritatively through Asset Type → Asset Category → Client — so the Type
 * carries NO `client_id` of its own and can never drift from its Category's
 * Client.
 *
 * `code` is unique per Category (`asset_category_id + code`), so the same
 * type code may exist under different Categories (and therefore different
 * Clients). Type codes are DATA, not behavior.
 *
 * Inactive Asset Types are retained for history rather than hard-deleted.
 */
export const migration0045CreateAssetTypes: Migration = {
  id: '0045_create_asset_types',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE asset_types (
        id                UUID PRIMARY KEY,
        asset_category_id UUID NOT NULL,
        code              TEXT NOT NULL,
        name              TEXT NOT NULL,
        description       TEXT,
        status            TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT asset_types_asset_category_id_fkey
          FOREIGN KEY (asset_category_id) REFERENCES asset_categories (id),
        CONSTRAINT asset_types_category_code_unique
          UNIQUE (asset_category_id, code),
        CONSTRAINT asset_types_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX asset_types_asset_category_id_idx
         ON asset_types (asset_category_id)`,
    );
    await client.query(
      `CREATE INDEX asset_types_status_idx ON asset_types (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS asset_types');
  },
};

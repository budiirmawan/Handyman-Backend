import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05B — Optional Asset → Classification references.
 *
 * `asset_category_id` and `asset_type_id` are NULLABLE and default to NULL,
 * so every Asset registered under BE-05A (and every Asset that simply has no
 * classification) remains valid without change. Classification is never
 * mandatory.
 *
 * Two business rules are enforced by the service layer, where they also yield
 * the proper API error — the FKs here guarantee referential integrity only:
 *
 *   1. Client-context integrity: an Asset may only be classified by a
 *      Category of its OWN Client (`assets.client_id`), and by a Type whose
 *      Category resolves to that same Client.
 *   2. Hierarchy integrity: the assigned Type must belong to the assigned
 *      Category.
 *
 * Rule 2 is additionally backstopped in the schema by a composite FK: the
 * `(id, asset_category_id)` unique key on `asset_types` lets `assets`
 * reference `(asset_type_id, asset_category_id)` as a pair, so the database
 * itself refuses a Type/Category combination that does not match.
 */
export const migration0046AddAssetClassificationReference: Migration = {
  id: '0046_add_asset_classification_reference',

  async up(client: PoolClient): Promise<void> {
    // Composite key required to reference (type, category) as a matched pair.
    await client.query(`
      ALTER TABLE asset_types
        ADD CONSTRAINT asset_types_id_category_unique
          UNIQUE (id, asset_category_id)
    `);

    await client.query(`
      ALTER TABLE assets
        ADD COLUMN asset_category_id UUID,
        ADD COLUMN asset_type_id     UUID,
        ADD CONSTRAINT assets_asset_category_id_fkey
          FOREIGN KEY (asset_category_id) REFERENCES asset_categories (id),
        ADD CONSTRAINT assets_asset_type_category_fkey
          FOREIGN KEY (asset_type_id, asset_category_id)
          REFERENCES asset_types (id, asset_category_id)
    `);

    await client.query(
      `CREATE INDEX assets_asset_category_id_idx
         ON assets (asset_category_id)`,
    );
    await client.query(
      `CREATE INDEX assets_asset_type_id_idx ON assets (asset_type_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE assets
        DROP CONSTRAINT IF EXISTS assets_asset_type_category_fkey,
        DROP CONSTRAINT IF EXISTS assets_asset_category_id_fkey,
        DROP COLUMN IF EXISTS asset_type_id,
        DROP COLUMN IF EXISTS asset_category_id
    `);

    await client.query(`
      ALTER TABLE asset_types
        DROP CONSTRAINT IF EXISTS asset_types_id_category_unique
    `);
  },
};

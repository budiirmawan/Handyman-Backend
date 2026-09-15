import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16H — Asset Spare Part Binding.
 *
 * Many-to-many between Asset (BE-05) and SPARE_PART Item (BE-16A).
 * - client_id, building_id denormalized from Asset for isolation
 * - asset_id → assets, item_id → inventory_items
 * - required_quantity >0
 * - status ACTIVE/INACTIVE
 * - UNIQUE (asset_id, item_id) prevents duplicate active bindings
 * - Only SPARE_PART type enforced at service layer (not DB CHECK to allow future types)
 */
export const migration0173CreateInventoryAssetSpareParts: Migration = {
  id: '0173_create_inventory_asset_spare_parts',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_asset_spare_parts (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        building_id       UUID NOT NULL REFERENCES buildings (id),
        asset_id          UUID NOT NULL REFERENCES assets (id),
        item_id           UUID NOT NULL REFERENCES inventory_items (id),
        required_quantity NUMERIC NOT NULL DEFAULT 1,
        status            TEXT NOT NULL DEFAULT 'ACTIVE',
        notes             TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_asset_spare_parts_asset_item_unique
          UNIQUE (asset_id, item_id),
        CONSTRAINT inventory_asset_spare_parts_quantity_positive
          CHECK (required_quantity > 0),
        CONSTRAINT inventory_asset_spare_parts_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX inventory_asset_spare_parts_client_idx
        ON inventory_asset_spare_parts (client_id, status);
      CREATE INDEX inventory_asset_spare_parts_building_idx
        ON inventory_asset_spare_parts (building_id, status);
      CREATE INDEX inventory_asset_spare_parts_asset_idx
        ON inventory_asset_spare_parts (asset_id, status);
      CREATE INDEX inventory_asset_spare_parts_item_idx
        ON inventory_asset_spare_parts (item_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_asset_spare_parts');
  },
};

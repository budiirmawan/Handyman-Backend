import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16G — Minimum Stock threshold.
 *
 * One active threshold per Item + Warehouse.
 * - client_id, building_id, warehouse_id, item_id denormalized
 * - minimum_quantity >0
 * - status ACTIVE/INACTIVE
 * - UNIQUE (warehouse_id, item_id) to prevent duplicate active thresholds
 * - Comparison against available stock done at service layer (LOW vs OK)
 */
export const migration0172CreateInventoryMinimumStocks: Migration = {
  id: '0172_create_inventory_minimum_stocks',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_minimum_stocks (
        id               UUID PRIMARY KEY,
        client_id        UUID NOT NULL REFERENCES clients (id),
        building_id      UUID NOT NULL REFERENCES buildings (id),
        warehouse_id     UUID NOT NULL REFERENCES inventory_warehouses (id),
        item_id          UUID NOT NULL REFERENCES inventory_items (id),
        minimum_quantity NUMERIC NOT NULL,
        status           TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_minimum_stocks_warehouse_item_unique
          UNIQUE (warehouse_id, item_id),
        CONSTRAINT inventory_minimum_stocks_quantity_positive
          CHECK (minimum_quantity > 0),
        CONSTRAINT inventory_minimum_stocks_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX inventory_minimum_stocks_client_idx
        ON inventory_minimum_stocks (client_id, status);
      CREATE INDEX inventory_minimum_stocks_building_idx
        ON inventory_minimum_stocks (building_id, status);
      CREATE INDEX inventory_minimum_stocks_warehouse_idx
        ON inventory_minimum_stocks (warehouse_id, status);
      CREATE INDEX inventory_minimum_stocks_item_idx
        ON inventory_minimum_stocks (item_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_minimum_stocks');
  },
};

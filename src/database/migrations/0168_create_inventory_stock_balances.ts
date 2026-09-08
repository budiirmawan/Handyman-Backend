import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16C — Stock Balance foundation.
 *
 * Tracks quantity per Item + Warehouse/Store.
 * - client_id, building_id, warehouse_id, item_id all denormalized from warehouse for isolation and query speed.
 * - quantity_on_hand >=0, reserved_quantity >=0, reserved <= on_hand enforced via CHECK.
 * - available_quantity is GENERATED ALWAYS AS (on_hand - reserved) STORED to guarantee consistency.
 * - UNIQUE (warehouse_id, item_id) ensures one balance per Item+Warehouse.
 * - No movement table yet — BE-16D onward.
 */
export const migration0168CreateInventoryStockBalances: Migration = {
  id: '0168_create_inventory_stock_balances',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_stock_balances (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        building_id        UUID NOT NULL REFERENCES buildings (id),
        warehouse_id       UUID NOT NULL REFERENCES inventory_warehouses (id),
        item_id            UUID NOT NULL REFERENCES inventory_items (id),
        quantity_on_hand   NUMERIC NOT NULL DEFAULT 0,
        reserved_quantity  NUMERIC NOT NULL DEFAULT 0,
        available_quantity NUMERIC GENERATED ALWAYS AS (quantity_on_hand - reserved_quantity) STORED,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_stock_balances_warehouse_item_unique
          UNIQUE (warehouse_id, item_id),
        CONSTRAINT inventory_stock_balances_on_hand_non_negative
          CHECK (quantity_on_hand >= 0),
        CONSTRAINT inventory_stock_balances_reserved_non_negative
          CHECK (reserved_quantity >= 0),
        CONSTRAINT inventory_stock_balances_reserved_le_on_hand
          CHECK (reserved_quantity <= quantity_on_hand)
      )
    `);

    await client.query(`
      CREATE INDEX inventory_stock_balances_client_idx
        ON inventory_stock_balances (client_id, building_id);
      CREATE INDEX inventory_stock_balances_building_idx
        ON inventory_stock_balances (building_id);
      CREATE INDEX inventory_stock_balances_warehouse_idx
        ON inventory_stock_balances (warehouse_id);
      CREATE INDEX inventory_stock_balances_item_idx
        ON inventory_stock_balances (item_id);
      CREATE INDEX inventory_stock_balances_low_stock_idx
        ON inventory_stock_balances (available_quantity)
        WHERE available_quantity <= 0;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_stock_balances');
  },
};

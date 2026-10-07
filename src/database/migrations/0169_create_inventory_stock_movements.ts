import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16D — Stock In / Out movements.
 *
 * Append-only ledger of inventory changes that must atomically update
 * BE-16C Stock Balance (inventory_stock_balances).
 *
 * Fields:
 * - client_id, building_id, warehouse_id, item_id denormalized from warehouse for isolation.
 * - movement_type STOCK_IN / STOCK_OUT
 * - quantity >0
 * - movement_date TIMESTAMPTZ (user supplied or NOW)
 * - reference, source, notes optional
 * - performed_by_user_id
 * - resulting_quantity_on_hand, resulting_available snapshot for audit (optional but useful)
 * - created_at
 *
 * No edit/delete — immutability enforced at service layer.
 * Transaction safety: movement INSERT and balance UPDATE in same transaction with SELECT FOR UPDATE.
 */
export const migration0169CreateInventoryStockMovements: Migration = {
  id: '0169_create_inventory_stock_movements',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_stock_movements (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        warehouse_id                UUID NOT NULL REFERENCES inventory_warehouses (id),
        item_id                     UUID NOT NULL REFERENCES inventory_items (id),
        movement_type               TEXT NOT NULL,
        quantity                    NUMERIC NOT NULL,
        movement_date               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reference                   TEXT,
        source                      TEXT,
        performed_by_user_id        UUID NOT NULL REFERENCES users (id),
        notes                       TEXT,
        resulting_quantity_on_hand  NUMERIC NOT NULL,
        resulting_available_quantity NUMERIC NOT NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_stock_movements_type_check
          CHECK (movement_type IN ('STOCK_IN', 'STOCK_OUT')),
        CONSTRAINT inventory_stock_movements_quantity_positive
          CHECK (quantity > 0),
        CONSTRAINT inventory_stock_movements_resulting_on_hand_non_negative
          CHECK (resulting_quantity_on_hand >= 0),
        CONSTRAINT inventory_stock_movements_resulting_available_non_negative
          CHECK (resulting_available_quantity >= 0)
      )
    `);

    await client.query(`
      CREATE INDEX inventory_stock_movements_client_idx
        ON inventory_stock_movements (client_id, movement_date DESC);
      CREATE INDEX inventory_stock_movements_building_idx
        ON inventory_stock_movements (building_id, movement_date DESC);
      CREATE INDEX inventory_stock_movements_warehouse_idx
        ON inventory_stock_movements (warehouse_id, movement_date DESC);
      CREATE INDEX inventory_stock_movements_item_idx
        ON inventory_stock_movements (item_id, movement_date DESC);
      CREATE INDEX inventory_stock_movements_type_idx
        ON inventory_stock_movements (movement_type, movement_date DESC);
      CREATE INDEX inventory_stock_movements_performed_by_idx
        ON inventory_stock_movements (performed_by_user_id, movement_date DESC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_stock_movements');
  },
};

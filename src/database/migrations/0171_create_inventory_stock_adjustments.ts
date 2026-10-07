import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16F — Stock Adjustment.
 *
 * Corrective ledger for inventory counts.
 * Types: INCREASE, DECREASE, SET_BALANCE
 * - client_id, building_id, warehouse_id, item_id denormalized
 * - quantity: for INCREASE/DECREASE >0 delta, for SET_BALANCE >=0 target
 * - reason required
 * - performed_by, adjusted_at, reference, notes
 * - resulting quantities snapshot
 * - Append-only, no edit/delete
 */
export const migration0171CreateInventoryStockAdjustments: Migration = {
  id: '0171_create_inventory_stock_adjustments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_stock_adjustments (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        warehouse_id                UUID NOT NULL REFERENCES inventory_warehouses (id),
        item_id                     UUID NOT NULL REFERENCES inventory_items (id),
        adjustment_type             TEXT NOT NULL,
        quantity                    NUMERIC NOT NULL,
        reason                      TEXT NOT NULL,
        adjusted_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reference                   TEXT,
        performed_by_user_id        UUID NOT NULL REFERENCES users (id),
        notes                       TEXT,
        resulting_quantity_on_hand  NUMERIC NOT NULL,
        resulting_available_quantity NUMERIC NOT NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_adjustments_type_check
          CHECK (adjustment_type IN ('INCREASE', 'DECREASE', 'SET_BALANCE')),
        CONSTRAINT inventory_adjustments_quantity_non_negative
          CHECK (quantity >= 0),
        CONSTRAINT inventory_adjustments_resulting_on_hand_non_negative
          CHECK (resulting_quantity_on_hand >= 0),
        CONSTRAINT inventory_adjustments_resulting_available_non_negative
          CHECK (resulting_available_quantity >= 0)
      )
    `);

    await client.query(`
      CREATE INDEX inventory_adjustments_client_idx
        ON inventory_stock_adjustments (client_id, adjusted_at DESC);
      CREATE INDEX inventory_adjustments_building_idx
        ON inventory_stock_adjustments (building_id, adjusted_at DESC);
      CREATE INDEX inventory_adjustments_warehouse_idx
        ON inventory_stock_adjustments (warehouse_id, adjusted_at DESC);
      CREATE INDEX inventory_adjustments_item_idx
        ON inventory_stock_adjustments (item_id, adjusted_at DESC);
      CREATE INDEX inventory_adjustments_type_idx
        ON inventory_stock_adjustments (adjustment_type, adjusted_at DESC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_stock_adjustments');
  },
};

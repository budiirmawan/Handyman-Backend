import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16E — Stock Transfer.
 *
 * Transfers quantity of one Item from source warehouse to destination warehouse.
 * - client_id denormalized, same client enforced
 * - source/destination warehouses must be different
 * - quantity >0
 * - source must have sufficient available stock
 * - Atomic: source decrease, destination increase, transfer record, two stock movements
 * - Status: COMPLETED (simple), CANCELLED for future, but immutable once COMPLETED
 * - No adjustment yet
 */
export const migration0170CreateInventoryStockTransfers: Migration = {
  id: '0170_create_inventory_stock_transfers',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_stock_transfers (
        id                              UUID PRIMARY KEY,
        client_id                       UUID NOT NULL REFERENCES clients (id),
        source_warehouse_id             UUID NOT NULL REFERENCES inventory_warehouses (id),
        destination_warehouse_id        UUID NOT NULL REFERENCES inventory_warehouses (id),
        source_building_id              UUID NOT NULL REFERENCES buildings (id),
        destination_building_id         UUID NOT NULL REFERENCES buildings (id),
        item_id                         UUID NOT NULL REFERENCES inventory_items (id),
        quantity                        NUMERIC NOT NULL,
        transfer_date                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status                          TEXT NOT NULL DEFAULT 'COMPLETED',
        reference                       TEXT,
        performed_by_user_id            UUID NOT NULL REFERENCES users (id),
        notes                           TEXT,
        resulting_source_on_hand        NUMERIC NOT NULL,
        resulting_source_available      NUMERIC NOT NULL,
        resulting_destination_on_hand   NUMERIC NOT NULL,
        resulting_destination_available NUMERIC NOT NULL,
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_transfers_quantity_positive
          CHECK (quantity > 0),
        CONSTRAINT inventory_transfers_source_destination_different
          CHECK (source_warehouse_id <> destination_warehouse_id),
        CONSTRAINT inventory_transfers_status_check
          CHECK (status IN ('COMPLETED', 'CANCELLED')),
        CONSTRAINT inventory_transfers_source_on_hand_non_negative
          CHECK (resulting_source_on_hand >= 0),
        CONSTRAINT inventory_transfers_source_available_non_negative
          CHECK (resulting_source_available >= 0),
        CONSTRAINT inventory_transfers_destination_on_hand_non_negative
          CHECK (resulting_destination_on_hand >= 0),
        CONSTRAINT inventory_transfers_destination_available_non_negative
          CHECK (resulting_destination_available >= 0)
      )
    `);

    await client.query(`
      CREATE INDEX inventory_transfers_client_idx
        ON inventory_stock_transfers (client_id, transfer_date DESC);
      CREATE INDEX inventory_transfers_source_idx
        ON inventory_stock_transfers (source_warehouse_id, transfer_date DESC);
      CREATE INDEX inventory_transfers_destination_idx
        ON inventory_stock_transfers (destination_warehouse_id, transfer_date DESC);
      CREATE INDEX inventory_transfers_item_idx
        ON inventory_stock_transfers (item_id, transfer_date DESC);
      CREATE INDEX inventory_transfers_building_idx
        ON inventory_stock_transfers (source_building_id, destination_building_id, transfer_date DESC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_stock_transfers');
  },
};

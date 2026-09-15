import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16I — Work Order Material Usage.
 *
 * Records material consumption against a Work Order, reducing stock via authoritative stock logic.
 * - client_id, building_id, work_order_id, warehouse_id, item_id denormalized
 * - quantity >0
 * - used_by_user_id, used_at, reference, notes
 * - resulting quantities snapshot
 * - Append-only, no edit/delete, transaction-safe with balance update + stock movement
 */
export const migration0174CreateInventoryWorkOrderMaterialUsages: Migration = {
  id: '0174_create_inventory_work_order_material_usages',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_work_order_material_usages (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        work_order_id               UUID NOT NULL REFERENCES work_orders (id),
        warehouse_id                UUID NOT NULL REFERENCES inventory_warehouses (id),
        item_id                     UUID NOT NULL REFERENCES inventory_items (id),
        quantity                    NUMERIC NOT NULL,
        used_by_user_id             UUID NOT NULL REFERENCES users (id),
        used_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        reference                   TEXT,
        notes                       TEXT,
        resulting_quantity_on_hand  NUMERIC NOT NULL,
        resulting_available_quantity NUMERIC NOT NULL,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_wo_usage_quantity_positive
          CHECK (quantity > 0),
        CONSTRAINT inventory_wo_usage_resulting_on_hand_non_negative
          CHECK (resulting_quantity_on_hand >= 0),
        CONSTRAINT inventory_wo_usage_resulting_available_non_negative
          CHECK (resulting_available_quantity >= 0)
      )
    `);

    await client.query(`
      CREATE INDEX inventory_wo_usage_client_idx
        ON inventory_work_order_material_usages (client_id, used_at DESC);
      CREATE INDEX inventory_wo_usage_building_idx
        ON inventory_work_order_material_usages (building_id, used_at DESC);
      CREATE INDEX inventory_wo_usage_work_order_idx
        ON inventory_work_order_material_usages (work_order_id, used_at DESC);
      CREATE INDEX inventory_wo_usage_warehouse_idx
        ON inventory_work_order_material_usages (warehouse_id, used_at DESC);
      CREATE INDEX inventory_wo_usage_item_idx
        ON inventory_work_order_material_usages (item_id, used_at DESC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_work_order_material_usages');
  },
};

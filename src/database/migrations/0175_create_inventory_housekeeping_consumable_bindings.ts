import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16J — Housekeeping Consumable Binding.
 *
 * Binds BE-11J consumable_requirements (operational) to BE-16A inventory_items (CONSUMABLE)
 * and BE-16B warehouse for authoritative stock.
 * - client_id, building_id, cleaning_area_id denormalized from consumable requirement
 * - consumable_requirement_id → consumable_requirements
 * - item_id → inventory_items (CONSUMABLE)
 * - warehouse_id → inventory_warehouses
 * - required_quantity >0
 * - status ACTIVE/INACTIVE
 * - UNIQUE (consumable_requirement_id, warehouse_id, item_id) prevents duplicate
 * - Readiness derived at service layer from stock balance (READY/LOW/NOT_READY)
 */
export const migration0175CreateInventoryHousekeepingConsumableBindings: Migration = {
  id: '0175_create_inventory_housekeeping_consumable_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_housekeeping_consumable_bindings (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        cleaning_area_id            UUID REFERENCES cleaning_areas (id),
        consumable_requirement_id   UUID NOT NULL REFERENCES consumable_requirements (id),
        item_id                     UUID NOT NULL REFERENCES inventory_items (id),
        warehouse_id                UUID NOT NULL REFERENCES inventory_warehouses (id),
        required_quantity           NUMERIC NOT NULL DEFAULT 1,
        status                      TEXT NOT NULL DEFAULT 'ACTIVE',
        notes                       TEXT,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_hk_consumable_bindings_unique
          UNIQUE (consumable_requirement_id, warehouse_id, item_id),
        CONSTRAINT inventory_hk_consumable_bindings_quantity_positive
          CHECK (required_quantity > 0),
        CONSTRAINT inventory_hk_consumable_bindings_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX inventory_hk_consumable_bindings_client_idx
        ON inventory_housekeeping_consumable_bindings (client_id, status);
      CREATE INDEX inventory_hk_consumable_bindings_building_idx
        ON inventory_housekeeping_consumable_bindings (building_id, status);
      CREATE INDEX inventory_hk_consumable_bindings_cleaning_area_idx
        ON inventory_housekeeping_consumable_bindings (cleaning_area_id, status);
      CREATE INDEX inventory_hk_consumable_bindings_requirement_idx
        ON inventory_housekeeping_consumable_bindings (consumable_requirement_id, status);
      CREATE INDEX inventory_hk_consumable_bindings_item_idx
        ON inventory_housekeeping_consumable_bindings (item_id, status);
      CREATE INDEX inventory_hk_consumable_bindings_warehouse_idx
        ON inventory_housekeeping_consumable_bindings (warehouse_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_housekeeping_consumable_bindings');
  },
};

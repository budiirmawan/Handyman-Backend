import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-16B — Warehouse / Store foundation.
 *
 * A Warehouse/Store is a physical storage location owned by one Client
 * and operated within exactly one Building (Client → Property → Building → Warehouse).
 * Client_id is denormalized from Building for isolation, derived authoritatively
 * via Building → Property → Client.
 *
 * Code is unique per Building (building_id + code), matching cleaning_areas /
 * functional_locations precedent. Building-level uniqueness allows same code
 * in different buildings while preventing collision inside one building.
 *
 * Optional location binding: functional_location_id → functional_locations.
 * The finer hierarchy is NOT duplicated; service validates same Building and
 * ACTIVE status.
 *
 * Status: ACTIVE / INACTIVE — inactive preserved, not hard-deleted.
 * No stock balance or movement here — BE-16C onward.
 */
export const migration0167CreateInventoryWarehouses: Migration = {
  id: '0167_create_inventory_warehouses',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_warehouses (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        functional_location_id  UUID REFERENCES functional_locations (id),
        code                    TEXT NOT NULL,
        name                    TEXT NOT NULL,
        description             TEXT,
        status                  TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_warehouses_building_code_unique
          UNIQUE (building_id, code),
        CONSTRAINT inventory_warehouses_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX inventory_warehouses_client_idx
        ON inventory_warehouses (client_id, status);
      CREATE INDEX inventory_warehouses_building_idx
        ON inventory_warehouses (building_id, status);
      CREATE INDEX inventory_warehouses_location_idx
        ON inventory_warehouses (functional_location_id)
        WHERE functional_location_id IS NOT NULL;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_warehouses');
  },
};

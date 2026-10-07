import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-INV-CONTROL-01 PART 01 — Material Reservation Foundation.
 *
 * A reservation is an allocation of an existing approved Material Request
 * against one existing Item + Warehouse stock balance. It is deliberately not
 * a demand or approved-quantity authority: `material_requests.approved_quantity`
 * remains authoritative for demand, while `reserved_quantity` on
 * `inventory_stock_balances` remains authoritative for current stock.
 *
 * Reservation rows are append-oriented lifecycle records. The original
 * `reserved_quantity` is retained on the row; release/cancel transitions the
 * row once and reduces the linked balance by that amount in the same
 * transaction. No issue/consumption state is introduced in this PART.
 */
export const migration0287CreateInventoryMaterialReservations: Migration = {
  id: '0287_create_inventory_material_reservations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inventory_material_reservations (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        material_request_id   UUID NOT NULL REFERENCES material_requests (id),
        warehouse_id          UUID NOT NULL REFERENCES inventory_warehouses (id),
        item_id              UUID NOT NULL REFERENCES inventory_items (id),
        uom_id               UUID REFERENCES units_of_measure (id),
        reserved_quantity    NUMERIC NOT NULL,
        status               TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id   UUID NOT NULL REFERENCES users (id),
        released_by_user_id  UUID REFERENCES users (id),
        cancelled_by_user_id UUID REFERENCES users (id),
        notes                TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        released_at          TIMESTAMPTZ,
        cancelled_at         TIMESTAMPTZ,
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inventory_material_reservation_status_check
          CHECK (status IN ('ACTIVE', 'RELEASED', 'CANCELLED')),
        CONSTRAINT inventory_material_reservation_quantity_positive
          CHECK (reserved_quantity > 0),
        CONSTRAINT inventory_material_reservation_lifecycle_check
          CHECK (
            (
              status = 'ACTIVE'
              AND released_at IS NULL
              AND released_by_user_id IS NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL
            )
            OR (
              status = 'RELEASED'
              AND released_at IS NOT NULL
              AND released_by_user_id IS NOT NULL
              AND cancelled_at IS NULL
              AND cancelled_by_user_id IS NULL
            )
            OR (
              status = 'CANCELLED'
              AND cancelled_at IS NOT NULL
              AND cancelled_by_user_id IS NOT NULL
              AND released_at IS NULL
              AND released_by_user_id IS NULL
            )
          )
      )
    `);

    await client.query(`
      CREATE INDEX inventory_material_reservations_client_idx
        ON inventory_material_reservations (client_id, status, created_at DESC);
      CREATE INDEX inventory_material_reservations_building_idx
        ON inventory_material_reservations (building_id, status, created_at DESC);
      CREATE INDEX inventory_material_reservations_material_request_idx
        ON inventory_material_reservations (material_request_id, status, created_at DESC);
      CREATE INDEX inventory_material_reservations_warehouse_item_idx
        ON inventory_material_reservations (warehouse_id, item_id, status);
      CREATE INDEX inventory_material_reservations_created_by_idx
        ON inventory_material_reservations (created_by_user_id, created_at DESC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inventory_material_reservations');
  },
};

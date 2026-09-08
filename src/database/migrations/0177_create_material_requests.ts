import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-17B — Material Request.
 *
 * A Material Request is a line item on a Purchase Request (BE-17A) that asks
 * for a quantity of a BE-16 Inventory Item. It is deliberately lightweight:
 * it carries no approval, vendor selection, purchase order, receiving, or
 * payment/accounting concerns — those belong to later BE-17 PARTs.
 *
 * It reuses existing foundations and does NOT create a duplicate item master:
 * `item_id` references `inventory_items` (BE-16A) and `uom_id` is derived from
 * (and validated against) the item's UOM. `client_id` and `building_id` are
 * derived authoritatively from the Purchase Request (which itself derives them
 * from Building → Property → Client), so isolation can never drift from BE-02.
 * `warehouse_id` is optional and must resolve to the same Building as the
 * Purchase Request when provided.
 *
 * Quantity must be positive (`CHECK (quantity > 0)`). Status is OPEN /
 * CANCELLED.
 */
export const migration0177CreateMaterialRequests: Migration = {
  id: '0177_create_material_requests',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE material_requests (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        purchase_request_id   UUID NOT NULL REFERENCES purchase_requests (id),
        item_id               UUID NOT NULL REFERENCES inventory_items (id),
        warehouse_id          UUID REFERENCES inventory_warehouses (id),
        quantity              NUMERIC NOT NULL,
        uom_id                UUID REFERENCES units_of_measure (id),
        required_date         TIMESTAMPTZ,
        notes                 TEXT,
        status                TEXT NOT NULL DEFAULT 'OPEN',
        requested_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT material_request_status
          CHECK (status IN ('OPEN', 'CANCELLED')),
        CONSTRAINT material_request_quantity_positive
          CHECK (quantity > 0)
      )
    `);

    await client.query(`
      CREATE INDEX material_requests_client_idx
        ON material_requests (client_id, status);
      CREATE INDEX material_requests_building_idx
        ON material_requests (building_id, status, created_at);
      CREATE INDEX material_requests_purchase_request_idx
        ON material_requests (purchase_request_id, status);
      CREATE INDEX material_requests_item_idx
        ON material_requests (item_id, status);
      CREATE INDEX material_requests_warehouse_idx
        ON material_requests (warehouse_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS material_requests');
  },
};

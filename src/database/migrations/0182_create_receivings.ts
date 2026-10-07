import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-17G — Receiving.
 *
 * Records the receipt of goods/services for an approved Procurement request
 * (BE-17A Purchase Request or BE-17C Service Request) from a selected Vendor.
 * It must reference valid procurement readiness context (a READY
 * `purchase_order_readiness` for the request + vendor).
 *
 * For material/item receiving, the BE-16 stock-in logic is reused (a STOCK_IN
 * `inventory_stock_movements` row is created and its id recorded here) — no
 * duplicate inventory movement logic. Service receiving records acceptance
 * without any stock movement.
 *
 * `client_id` and `building_id` are derived authoritatively from the
 * referenced request. No invoice, payment, tax, accounting, or 3-way matching.
 */
export const migration0182CreateReceivings: Migration = {
  id: '0182_create_receivings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE receivings (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        request_type             TEXT NOT NULL,
        purchase_request_id      UUID REFERENCES purchase_requests (id),
        service_request_id       UUID REFERENCES service_requests (id),
        vendor_id                UUID NOT NULL REFERENCES vendors (id),
        receiving_type           TEXT NOT NULL,
        item_id                  UUID REFERENCES inventory_items (id),
        warehouse_id             UUID REFERENCES inventory_warehouses (id),
        quantity                 NUMERIC,
        stock_movement_id        UUID REFERENCES inventory_stock_movements (id),
        received_by_user_id      UUID NOT NULL REFERENCES users (id),
        received_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status                   TEXT NOT NULL DEFAULT 'RECEIVED',
        notes                    TEXT,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT receiving_request_type_check
          CHECK (request_type IN ('PURCHASE_REQUEST', 'SERVICE_REQUEST')),
        CONSTRAINT receiving_request_reference_check
          CHECK (
            (purchase_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT receiving_type_check
          CHECK (receiving_type IN ('MATERIAL', 'SERVICE')),
        CONSTRAINT receiving_status_check
          CHECK (status IN ('RECEIVED', 'FINALIZED')),
        CONSTRAINT receiving_quantity_positive
          CHECK (quantity IS NULL OR quantity > 0)
      )
    `);

    await client.query(`
      CREATE INDEX receivings_building_idx
        ON receivings (building_id, status, received_at);
      CREATE INDEX receivings_request_idx
        ON receivings (request_type, purchase_request_id, service_request_id);
      CREATE INDEX receivings_vendor_idx
        ON receivings (vendor_id, status, received_at);
      CREATE INDEX receivings_receiving_type_idx
        ON receivings (receiving_type, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS receivings');
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-17H — Work Order Procurement Binding.
 *
 * Binds an existing BE-08 Work Order to its BE-17A Purchase Request, and
 * optionally to the specific BE-17B Material Request / BE-17C Service Request
 * and a BE-17G Receiving. It does NOT create a separate Work Order procurement
 * engine — it reuses BE-08 Work Order, BE-16 Inventory, and BE-17A–BE-17G.
 *
 * `client_id` and `building_id` are stored and validated so the procurement
 * context must belong to the same Client / Building as the Work Order.
 * `procurement_status` is backend-authoritative: BOUND on create, promoted to
 * READY when a READY PO readiness exists for the request, and to RECEIVED when
 * a receiving is linked.
 *
 * No invoice, payment, tax, or accounting.
 */
export const migration0183CreateWorkOrderProcurementBindings: Migration = {
  id: '0183_create_work_order_procurement_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE work_order_procurement_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        work_order_id          UUID NOT NULL REFERENCES work_orders (id),
        purchase_request_id    UUID NOT NULL REFERENCES purchase_requests (id),
        material_request_id    UUID REFERENCES material_requests (id),
        service_request_id     UUID REFERENCES service_requests (id),
        receiving_id           UUID REFERENCES receivings (id),
        procurement_status     TEXT NOT NULL DEFAULT 'BOUND',
        notes                  TEXT,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT wo_procurement_status_check
          CHECK (procurement_status IN ('BOUND', 'READY', 'RECEIVED')),
        CONSTRAINT wo_procurement_request_reference_check
          CHECK (
            (material_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int <= 1
          )
      )
    `);

    await client.query(`
      CREATE INDEX wo_procurement_work_order_idx
        ON work_order_procurement_bindings (work_order_id, procurement_status);
      CREATE INDEX wo_procurement_purchase_request_idx
        ON work_order_procurement_bindings (purchase_request_id, procurement_status);
      CREATE INDEX wo_procurement_material_request_idx
        ON work_order_procurement_bindings (material_request_id);
      CREATE INDEX wo_procurement_service_request_idx
        ON work_order_procurement_bindings (service_request_id);
      CREATE INDEX wo_procurement_building_idx
        ON work_order_procurement_bindings (building_id, procurement_status);
      CREATE UNIQUE INDEX wo_procurement_work_order_unique
        ON work_order_procurement_bindings (work_order_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS work_order_procurement_bindings');
  },
};

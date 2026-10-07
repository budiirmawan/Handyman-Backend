import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-17F — Purchase Order Readiness.
 *
 * A snapshot of whether an approved Procurement request (BE-17A Purchase
 * Request or BE-17C Service Request) with a selected Vendor (BE-17E) is ready
 * to become a Purchase Order. This is PO readiness ONLY — it is not a full
 * Purchase Order / ERP engine and carries no invoice, payment, tax,
 * accounting, or 3-way matching.
 *
 * Readiness is resolved from existing foundations at evaluation time: an
 * approved approval binding (BE-17D), a READY Vendor Selection Readiness
 * (BE-17E), and a valid material/service context (BE-17B material request /
 * BE-17C service request).
 *
 * `client_id` and `building_id` are derived authoritatively from the
 * referenced request. Statuses: READY / NOT_READY / BLOCKED.
 */
export const migration0181CreatePurchaseOrderReadiness: Migration = {
  id: '0181_create_purchase_order_readiness',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE purchase_order_readiness (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        request_type            TEXT NOT NULL,
        purchase_request_id     UUID REFERENCES purchase_requests (id),
        service_request_id      UUID REFERENCES service_requests (id),
        vendor_id               UUID NOT NULL REFERENCES vendors (id),
        material_context_ok     BOOLEAN NOT NULL,
        service_context_ok      BOOLEAN NOT NULL,
        approval_ok             BOOLEAN NOT NULL,
        vendor_ok               BOOLEAN NOT NULL,
        readiness               TEXT NOT NULL,
        required_date           TIMESTAMPTZ,
        notes                   TEXT,
        prepared_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT po_readiness_request_type_check
          CHECK (request_type IN ('PURCHASE_REQUEST', 'SERVICE_REQUEST')),
        CONSTRAINT po_readiness_request_reference_check
          CHECK (
            (purchase_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT po_readiness_status_check
          CHECK (readiness IN ('READY', 'NOT_READY', 'BLOCKED'))
      )
    `);

    await client.query(`
      CREATE INDEX po_readiness_building_idx
        ON purchase_order_readiness (building_id, readiness, created_at);
      CREATE INDEX po_readiness_request_idx
        ON purchase_order_readiness (request_type, purchase_request_id, service_request_id);
      CREATE INDEX po_readiness_vendor_idx
        ON purchase_order_readiness (vendor_id, readiness);
      CREATE UNIQUE INDEX po_readiness_vendor_request_unique
        ON purchase_order_readiness (vendor_id, purchase_request_id, service_request_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS purchase_order_readiness');
  },
};

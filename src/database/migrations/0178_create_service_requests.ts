import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-17C — Service Request.
 *
 * A Service Request is a procurement / service-demand line item on a Purchase
 * Request (BE-17A). It expresses a demand for an operational service. It is
 * deliberately lightweight: it carries no approval, vendor selection, PO
 * readiness, or operational Work Order execution — those belong to later BE-17
 * PARTs (and Work Order execution stays in BE-08).
 *
 * It reuses existing foundations and does NOT create a duplicate Vendor or
 * Work Order engine: `vendor_id` (when provided, deferred to later PARTs for
 * vendor selection) references `vendors` (BE-06). `client_id` and `building_id`
 * are derived authoritatively from the Purchase Request, so isolation never
 * drifts from BE-02. `functional_location_id` (when provided) is an optional
 * Building-scoped location context and must resolve to the same Building.
 *
 * `service_type` is a data-driven code string (no hardcoded model). Status is
 * OPEN / CANCELLED.
 */
export const migration0178CreateServiceRequests: Migration = {
  id: '0178_create_service_requests',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE service_requests (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        purchase_request_id      UUID NOT NULL REFERENCES purchase_requests (id),
        service_type             TEXT NOT NULL,
        title                    TEXT NOT NULL,
        description              TEXT,
        required_date            TIMESTAMPTZ,
        functional_location_id   UUID REFERENCES functional_locations (id),
        vendor_id                UUID REFERENCES vendors (id),
        notes                    TEXT,
        status                   TEXT NOT NULL DEFAULT 'OPEN',
        requested_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT service_request_status
          CHECK (status IN ('OPEN', 'CANCELLED'))
      )
    `);

    await client.query(`
      CREATE INDEX service_requests_client_idx
        ON service_requests (client_id, status);
      CREATE INDEX service_requests_building_idx
        ON service_requests (building_id, status, created_at);
      CREATE INDEX service_requests_purchase_request_idx
        ON service_requests (purchase_request_id, status);
      CREATE INDEX service_requests_service_type_idx
        ON service_requests (service_type, status);
      CREATE INDEX service_requests_location_idx
        ON service_requests (functional_location_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS service_requests');
  },
};

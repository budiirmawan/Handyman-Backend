import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-17E — Vendor Selection Readiness.
 *
 * Records a snapshot of whether a candidate Vendor (BE-06) is ready to be
 * selected for a Procurement request (BE-17A Purchase Request or BE-17C
 * Service Request). It is NOT a tender / RFQ / bidding platform and carries no
 * scoring engine or Purchase Order Readiness.
 *
 * `client_id` and `building_id` are derived authoritatively from the
 * referenced request, so isolation never drifts from BE-02. The readiness
 * snapshot is stored at evaluation time (the individual checks and the
 * resolved `readiness` status), reusing BE-06 Vendor classification,
 * capability, Building relationship, compliance, and license/certification
 * data.
 *
 * Statuses: READY / NOT_READY / EXPIRED / INELIGIBLE. A request_type guard and
 * a single-reference guard keep the binding consistent.
 */
export const migration0180CreateVendorSelectionReadiness: Migration = {
  id: '0180_create_vendor_selection_readiness',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_selection_readiness (
        id                          UUID PRIMARY KEY,
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        request_type                TEXT NOT NULL,
        purchase_request_id         UUID REFERENCES purchase_requests (id),
        service_request_id          UUID REFERENCES service_requests (id),
        vendor_id                   UUID NOT NULL REFERENCES vendors (id),
        service_type                TEXT NOT NULL,
        vendor_active               BOOLEAN NOT NULL,
        building_relationship_ok    BOOLEAN NOT NULL,
        capability_match            BOOLEAN NOT NULL,
        compliance_ok               BOOLEAN NOT NULL,
        license_ok                  BOOLEAN NOT NULL,
        approval_ok                 BOOLEAN NOT NULL,
        readiness                   TEXT NOT NULL,
        notes                       TEXT,
        evaluated_by_user_id        UUID NOT NULL REFERENCES users (id),
        evaluated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_selection_request_type_check
          CHECK (request_type IN ('PURCHASE_REQUEST', 'SERVICE_REQUEST')),
        CONSTRAINT vendor_selection_request_reference_check
          CHECK (
            (purchase_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT vendor_selection_readiness_check
          CHECK (readiness IN ('READY', 'NOT_READY', 'EXPIRED', 'INELIGIBLE'))
      )
    `);

    await client.query(`
      CREATE INDEX vendor_selection_building_idx
        ON vendor_selection_readiness (building_id, request_type, evaluated_at);
      CREATE INDEX vendor_selection_request_idx
        ON vendor_selection_readiness (request_type, purchase_request_id, service_request_id);
      CREATE INDEX vendor_selection_vendor_idx
        ON vendor_selection_readiness (vendor_id, evaluated_at);
      CREATE UNIQUE INDEX vendor_selection_vendor_request_unique
        ON vendor_selection_readiness (vendor_id, purchase_request_id, service_request_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_selection_readiness');
  },
};

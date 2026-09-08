import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-17D — Procurement Approval Binding.
 *
 * Explicitly binds an approval decision to one existing Procurement request
 * type (BE-17A Purchase Request, BE-17B Material Request, BE-17C Service
 * Request). It is NOT a new generic approval engine — it reuses the
 * authoritative available-actions / workflow pattern already established by
 * BE-14H tenant approval bindings, scoped to Procurement.
 *
 * Only the assigned authorized approver may decide, and decisions are
 * append-only history: a row moves once from PENDING to a terminal decision
 * and is never overwritten (`decide` is guarded by `status = 'PENDING'` and
 * the DB decision-consistency check enforces the invariant).
 *
 * `client_id` and `building_id` are derived authoritatively from the referenced
 * request, so isolation never drifts from BE-02.
 */
export const migration0179CreateProcurementApprovalBindings: Migration = {
  id: '0179_create_procurement_approval_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE procurement_approval_bindings (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        request_type             TEXT NOT NULL,
        purchase_request_id      UUID REFERENCES purchase_requests (id),
        material_request_id      UUID REFERENCES material_requests (id),
        service_request_id       UUID REFERENCES service_requests (id),
        approval_type            TEXT NOT NULL,
        approver_user_id         UUID NOT NULL REFERENCES users (id),
        status                   TEXT NOT NULL DEFAULT 'PENDING',
        decided_at               TIMESTAMPTZ,
        decision_notes           TEXT,
        created_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT procurement_approval_request_type_check
          CHECK (request_type IN ('PURCHASE_REQUEST', 'MATERIAL_REQUEST', 'SERVICE_REQUEST')),
        CONSTRAINT procurement_approval_request_reference_check
          CHECK (
            (purchase_request_id IS NOT NULL)::int
            + (material_request_id IS NOT NULL)::int
            + (service_request_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT procurement_approval_request_type_reference_check
          CHECK (
            (request_type = 'PURCHASE_REQUEST' AND purchase_request_id IS NOT NULL)
            OR (request_type = 'MATERIAL_REQUEST' AND material_request_id IS NOT NULL)
            OR (request_type = 'SERVICE_REQUEST' AND service_request_id IS NOT NULL)
          ),
        CONSTRAINT procurement_approval_status_check
          CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        CONSTRAINT procurement_approval_decision_consistency_check
          CHECK (
            (status = 'PENDING' AND decided_at IS NULL AND decision_notes IS NULL)
            OR (status IN ('APPROVED', 'REJECTED') AND decided_at IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX procurement_approval_pr_pending_unique
        ON procurement_approval_bindings
          (purchase_request_id, approval_type, approver_user_id)
        WHERE status = 'PENDING' AND purchase_request_id IS NOT NULL;
      CREATE UNIQUE INDEX procurement_approval_mr_pending_unique
        ON procurement_approval_bindings
          (material_request_id, approval_type, approver_user_id)
        WHERE status = 'PENDING' AND material_request_id IS NOT NULL;
      CREATE UNIQUE INDEX procurement_approval_sr_pending_unique
        ON procurement_approval_bindings
          (service_request_id, approval_type, approver_user_id)
        WHERE status = 'PENDING' AND service_request_id IS NOT NULL;
      CREATE INDEX procurement_approval_building_pending_idx
        ON procurement_approval_bindings (building_id, status, created_at);
      CREATE INDEX procurement_approval_client_idx
        ON procurement_approval_bindings (client_id, status, created_at);
      CREATE INDEX procurement_approval_approver_idx
        ON procurement_approval_bindings (approver_user_id, status, created_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS procurement_approval_bindings');
  },
};

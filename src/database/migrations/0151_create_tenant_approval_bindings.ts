import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14H — Tenant Approval Binding.
 *
 * Explicitly binds an approval decision to one existing Tenant request type.
 * Decisions are append-only history: a row moves once from PENDING to a
 * terminal decision and is never overwritten.
 */
export const migration0151CreateTenantApprovalBindings: Migration = {
  id: '0151_create_tenant_approval_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_approval_bindings (
        id                         UUID PRIMARY KEY,
        client_id                  UUID NOT NULL REFERENCES clients (id),
        tenant_company_id          UUID NOT NULL REFERENCES tenant_companies (id),
        building_id                UUID NOT NULL REFERENCES buildings (id),
        request_type               TEXT NOT NULL,
        service_request_id         UUID REFERENCES tenant_service_requests (id),
        complaint_id               UUID REFERENCES tenant_complaints (id),
        utility_request_id         UUID REFERENCES tenant_utility_requests (id),
        approval_type              TEXT NOT NULL,
        approver_user_id           UUID NOT NULL REFERENCES users (id),
        status                     TEXT NOT NULL DEFAULT 'PENDING',
        decided_at                 TIMESTAMPTZ,
        decision_notes             TEXT,
        created_by_user_id         UUID NOT NULL REFERENCES users (id),
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_approval_request_type_check
          CHECK (request_type IN ('SERVICE_REQUEST', 'COMPLAINT', 'UTILITY_REQUEST')),
        CONSTRAINT tenant_approval_request_reference_check
          CHECK (
            (service_request_id IS NOT NULL)::int
            + (complaint_id IS NOT NULL)::int
            + (utility_request_id IS NOT NULL)::int = 1
          ),
        CONSTRAINT tenant_approval_request_type_reference_check
          CHECK (
            (request_type = 'SERVICE_REQUEST' AND service_request_id IS NOT NULL)
            OR (request_type = 'COMPLAINT' AND complaint_id IS NOT NULL)
            OR (request_type = 'UTILITY_REQUEST' AND utility_request_id IS NOT NULL)
          ),
        CONSTRAINT tenant_approval_status_check
          CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        CONSTRAINT tenant_approval_decision_consistency_check
          CHECK (
            (status = 'PENDING' AND decided_at IS NULL AND decision_notes IS NULL)
            OR (status IN ('APPROVED', 'REJECTED') AND decided_at IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX tenant_approval_service_pending_unique
        ON tenant_approval_bindings
          (service_request_id, approval_type, approver_user_id)
        WHERE status = 'PENDING' AND service_request_id IS NOT NULL;
      CREATE UNIQUE INDEX tenant_approval_complaint_pending_unique
        ON tenant_approval_bindings
          (complaint_id, approval_type, approver_user_id)
        WHERE status = 'PENDING' AND complaint_id IS NOT NULL;
      CREATE UNIQUE INDEX tenant_approval_utility_pending_unique
        ON tenant_approval_bindings
          (utility_request_id, approval_type, approver_user_id)
        WHERE status = 'PENDING' AND utility_request_id IS NOT NULL;
      CREATE INDEX tenant_approval_building_pending_idx
        ON tenant_approval_bindings (building_id, status, created_at);
      CREATE INDEX tenant_approval_tenant_idx
        ON tenant_approval_bindings (tenant_company_id, status, created_at);
      CREATE INDEX tenant_approval_approver_idx
        ON tenant_approval_bindings (approver_user_id, status, created_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_approval_bindings');
  },
};

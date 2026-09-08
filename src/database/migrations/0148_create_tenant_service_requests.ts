import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14E — Tenant Service Request intake.
 *
 * Tenant-specific intake remains a thin context layer. Operational work is
 * linked to the existing BE-08 Work Request / Work Order records instead of
 * duplicating their lifecycle or execution data.
 */
export const migration0148CreateTenantServiceRequests: Migration = {
  id: '0148_create_tenant_service_requests',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_service_requests (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id),
        tenant_pic_id     UUID NOT NULL REFERENCES tenant_pics (id),
        building_id       UUID NOT NULL REFERENCES buildings (id),
        space_id          UUID REFERENCES spaces (id),
        request_number    TEXT NOT NULL,
        request_type      TEXT NOT NULL,
        title             TEXT NOT NULL,
        description       TEXT,
        priority          TEXT NOT NULL DEFAULT 'MEDIUM',
        status            TEXT NOT NULL DEFAULT 'OPEN',
        requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        work_request_id   UUID REFERENCES work_requests (id),
        work_order_id     UUID REFERENCES work_orders (id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_service_requests_number_unique
          UNIQUE (client_id, request_number),
        CONSTRAINT tenant_service_requests_priority_check
          CHECK (priority IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT tenant_service_requests_status_check
          CHECK (status IN ('OPEN', 'CANCELLED', 'CONVERTED')),
        CONSTRAINT tenant_service_requests_binding_state_check
          CHECK (
            (status IN ('OPEN', 'CANCELLED')
              AND work_request_id IS NULL AND work_order_id IS NULL)
            OR (status = 'CONVERTED' AND work_request_id IS NOT NULL)
          ),
        CONSTRAINT tenant_service_requests_work_order_source_check
          CHECK (work_order_id IS NULL OR work_request_id IS NOT NULL),
        CONSTRAINT tenant_service_requests_work_request_unique
          UNIQUE (work_request_id),
        CONSTRAINT tenant_service_requests_work_order_unique
          UNIQUE (work_order_id)
      )
    `);

    await client.query(`
      CREATE INDEX tenant_service_requests_tenant_idx
        ON tenant_service_requests (tenant_company_id, status, requested_at);
      CREATE INDEX tenant_service_requests_building_idx
        ON tenant_service_requests (building_id, status, requested_at);
      CREATE INDEX tenant_service_requests_space_idx
        ON tenant_service_requests (space_id, status);
      CREATE INDEX tenant_service_requests_pic_idx
        ON tenant_service_requests (tenant_pic_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_service_requests');
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14G — Tenant Utility Request intake.
 *
 * Utility types remain data-driven codes. Operational execution references
 * existing BE-08 Work Requests and Work Orders rather than being duplicated.
 */
export const migration0150CreateTenantUtilityRequests: Migration = {
  id: '0150_create_tenant_utility_requests',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_utility_requests (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id),
        tenant_pic_id     UUID NOT NULL REFERENCES tenant_pics (id),
        building_id       UUID NOT NULL REFERENCES buildings (id),
        space_id          UUID NOT NULL REFERENCES spaces (id),
        utility_type      TEXT NOT NULL,
        request_number    TEXT NOT NULL,
        request_details   TEXT NOT NULL,
        requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status            TEXT NOT NULL DEFAULT 'OPEN',
        notes             TEXT,
        work_request_id   UUID REFERENCES work_requests (id),
        work_order_id     UUID REFERENCES work_orders (id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_utility_requests_number_unique
          UNIQUE (client_id, request_number),
        CONSTRAINT tenant_utility_requests_status_check
          CHECK (status IN ('OPEN', 'CANCELLED', 'CONVERTED')),
        CONSTRAINT tenant_utility_requests_binding_state_check
          CHECK (
            (status IN ('OPEN', 'CANCELLED')
              AND work_request_id IS NULL AND work_order_id IS NULL)
            OR (status = 'CONVERTED' AND work_request_id IS NOT NULL)
          ),
        CONSTRAINT tenant_utility_requests_work_order_source_check
          CHECK (work_order_id IS NULL OR work_request_id IS NOT NULL),
        CONSTRAINT tenant_utility_requests_work_request_unique
          UNIQUE (work_request_id),
        CONSTRAINT tenant_utility_requests_work_order_unique
          UNIQUE (work_order_id)
      )
    `);

    await client.query(`
      CREATE INDEX tenant_utility_requests_tenant_idx
        ON tenant_utility_requests (tenant_company_id, status, requested_at);
      CREATE INDEX tenant_utility_requests_building_idx
        ON tenant_utility_requests (building_id, status, requested_at);
      CREATE INDEX tenant_utility_requests_space_idx
        ON tenant_utility_requests (space_id, status);
      CREATE INDEX tenant_utility_requests_type_idx
        ON tenant_utility_requests (utility_type, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_utility_requests');
  },
};

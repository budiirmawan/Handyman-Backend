import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14F — Tenant Complaint intake.
 *
 * Complaint context is retained here while operational follow-up references
 * the existing BE-09 Finding and BE-08 Work Order records.
 */
export const migration0149CreateTenantComplaints: Migration = {
  id: '0149_create_tenant_complaints',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_complaints (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id),
        tenant_pic_id     UUID NOT NULL REFERENCES tenant_pics (id),
        building_id       UUID NOT NULL REFERENCES buildings (id),
        space_id          UUID REFERENCES spaces (id),
        complaint_number  TEXT NOT NULL,
        complaint_type    TEXT NOT NULL,
        title             TEXT NOT NULL,
        description       TEXT,
        severity          TEXT NOT NULL DEFAULT 'MEDIUM',
        status            TEXT NOT NULL DEFAULT 'OPEN',
        reported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finding_id        UUID REFERENCES findings (id),
        work_order_id     UUID REFERENCES work_orders (id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_complaints_number_unique
          UNIQUE (client_id, complaint_number),
        CONSTRAINT tenant_complaints_severity_check
          CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT tenant_complaints_status_check
          CHECK (status IN ('OPEN', 'CANCELLED', 'ESCALATED')),
        CONSTRAINT tenant_complaints_binding_state_check
          CHECK (
            (status IN ('OPEN', 'CANCELLED')
              AND finding_id IS NULL AND work_order_id IS NULL)
            OR (status = 'ESCALATED' AND finding_id IS NOT NULL)
          ),
        CONSTRAINT tenant_complaints_work_order_source_check
          CHECK (work_order_id IS NULL OR finding_id IS NOT NULL),
        CONSTRAINT tenant_complaints_finding_unique UNIQUE (finding_id),
        CONSTRAINT tenant_complaints_work_order_unique UNIQUE (work_order_id)
      )
    `);

    await client.query(`
      CREATE INDEX tenant_complaints_tenant_idx
        ON tenant_complaints (tenant_company_id, status, reported_at);
      CREATE INDEX tenant_complaints_building_idx
        ON tenant_complaints (building_id, status, reported_at);
      CREATE INDEX tenant_complaints_space_idx
        ON tenant_complaints (space_id, status);
      CREATE INDEX tenant_complaints_pic_idx
        ON tenant_complaints (tenant_pic_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_complaints');
  },
};

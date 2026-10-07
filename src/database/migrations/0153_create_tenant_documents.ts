import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14J — Tenant Document metadata.
 *
 * Stores metadata and an opaque file reference only. Building context is
 * optional for documents scoped to a specific Tenant Building; no file
 * binaries or generic document-management behavior live here.
 */
export const migration0153CreateTenantDocuments: Migration = {
  id: '0153_create_tenant_documents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_documents (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id),
        building_id       UUID REFERENCES buildings (id),
        document_type     TEXT NOT NULL,
        document_name     TEXT NOT NULL,
        document_number   TEXT NOT NULL,
        issue_date        TIMESTAMPTZ,
        expiry_date       TIMESTAMPTZ,
        file_reference    TEXT,
        status            TEXT NOT NULL DEFAULT 'ACTIVE',
        notes             TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_documents_status_check
          CHECK (status IN ('ACTIVE', 'EXPIRED', 'INACTIVE')),
        CONSTRAINT tenant_documents_date_range_check
          CHECK (
            issue_date IS NULL
            OR expiry_date IS NULL
            OR expiry_date >= issue_date
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX tenant_documents_active_unique
        ON tenant_documents (
          tenant_company_id,
          COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid),
          document_type,
          document_number
        )
        WHERE status = 'ACTIVE';
      CREATE INDEX tenant_documents_tenant_idx
        ON tenant_documents (tenant_company_id, status, document_type);
      CREATE INDEX tenant_documents_building_idx
        ON tenant_documents (building_id, status, document_type);
      CREATE INDEX tenant_documents_expiry_idx
        ON tenant_documents (expiry_date, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_documents');
  },
};

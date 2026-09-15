import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14A — Tenant Company foundation.
 *
 * A Tenant Company is Client-scoped operational master data and is distinct
 * from the Client (the property/building owner or operator). Later BE-14 parts
 * may reference this record for people, spaces and requests; none of those
 * relationships are introduced here.
 */
export const migration0144CreateTenantCompanies: Migration = {
  id: '0144_create_tenant_companies',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_companies (
        id           UUID PRIMARY KEY,
        client_id    UUID NOT NULL REFERENCES clients (id),
        tenant_code  TEXT NOT NULL,
        tenant_name  TEXT NOT NULL,
        legal_name   TEXT,
        email        TEXT,
        phone        TEXT,
        address      TEXT,
        status       TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_companies_client_code_unique
          UNIQUE (client_id, tenant_code),
        CONSTRAINT tenant_companies_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX tenant_companies_client_status_idx
        ON tenant_companies (client_id, status);
      CREATE INDEX tenant_companies_client_name_idx
        ON tenant_companies (client_id, LOWER(tenant_name));
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_companies');
  },
};

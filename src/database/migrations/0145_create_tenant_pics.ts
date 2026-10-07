import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14B — Tenant PIC / User binding.
 *
 * A Tenant PIC is contact data owned by an existing BE-14A Tenant Company.
 * `user_id` optionally links the contact to the existing User identity when
 * portal access is applicable; no User, credential, role or permission data
 * is duplicated here.
 */
export const migration0145CreateTenantPics: Migration = {
  id: '0145_create_tenant_pics',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_pics (
        id                 UUID PRIMARY KEY,
        tenant_company_id  UUID NOT NULL REFERENCES tenant_companies (id),
        user_id            UUID REFERENCES users (id),
        pic_name           TEXT NOT NULL,
        email              TEXT,
        phone              TEXT,
        role_title         TEXT,
        is_primary         BOOLEAN NOT NULL DEFAULT FALSE,
        status             TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_pics_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT tenant_pics_primary_active_check
          CHECK (NOT is_primary OR status = 'ACTIVE')
      )
    `);

    await client.query(`
      CREATE INDEX tenant_pics_company_status_idx
        ON tenant_pics (tenant_company_id, status);
      CREATE UNIQUE INDEX tenant_pics_primary_unique
        ON tenant_pics (tenant_company_id)
        WHERE is_primary;
      CREATE UNIQUE INDEX tenant_pics_company_user_unique
        ON tenant_pics (tenant_company_id, user_id)
        WHERE user_id IS NOT NULL;
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_pics');
  },
};

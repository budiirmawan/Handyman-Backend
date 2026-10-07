import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14D — Tenant Building Context.
 *
 * Records a Tenant Company's effective operational context in an existing
 * Building. Active contexts are established only from valid BE-14C space
 * relationships by the service; Building master data is never copied.
 */
export const migration0147CreateTenantBuildingContexts: Migration = {
  id: '0147_create_tenant_building_contexts',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_building_contexts (
        id                UUID PRIMARY KEY,
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id),
        building_id       UUID NOT NULL REFERENCES buildings (id),
        effective_from    TIMESTAMPTZ,
        effective_until   TIMESTAMPTZ,
        status            TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_building_contexts_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT tenant_building_contexts_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX tenant_building_contexts_active_unique
        ON tenant_building_contexts (tenant_company_id, building_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX tenant_building_contexts_company_idx
        ON tenant_building_contexts (tenant_company_id, status);
      CREATE INDEX tenant_building_contexts_building_idx
        ON tenant_building_contexts (building_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_building_contexts');
  },
};

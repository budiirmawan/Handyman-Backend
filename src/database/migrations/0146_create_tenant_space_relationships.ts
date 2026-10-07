import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14C — Tenant Company ↔ Space relationship.
 *
 * References existing Tenant Company, Building and Space masters without
 * copying their data. Inactive rows remain as relationship history. A Space
 * can have only one ACTIVE tenant relationship at a time.
 */
export const migration0146CreateTenantSpaceRelationships: Migration = {
  id: '0146_create_tenant_space_relationships',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_space_relationships (
        id               UUID PRIMARY KEY,
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id),
        building_id      UUID NOT NULL REFERENCES buildings (id),
        space_id         UUID NOT NULL REFERENCES spaces (id),
        effective_from   TIMESTAMPTZ,
        effective_until  TIMESTAMPTZ,
        status           TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_space_relationships_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT tenant_space_relationships_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX tenant_space_relationships_active_space_unique
        ON tenant_space_relationships (space_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX tenant_space_relationships_company_idx
        ON tenant_space_relationships (tenant_company_id, status);
      CREATE INDEX tenant_space_relationships_building_idx
        ON tenant_space_relationships (building_id, status);
      CREATE INDEX tenant_space_relationships_space_idx
        ON tenant_space_relationships (space_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_space_relationships');
  },
};

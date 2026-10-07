import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-14I — Tenant Contractor Relationship.
 *
 * Contractors reference the existing Vendor master. This table stores only
 * Tenant/Building/Space relationship context and lifecycle history.
 */
export const migration0152CreateTenantContractorRelationships: Migration = {
  id: '0152_create_tenant_contractor_relationships',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE tenant_contractor_relationships (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL REFERENCES clients (id),
        tenant_company_id    UUID NOT NULL REFERENCES tenant_companies (id),
        contractor_vendor_id UUID NOT NULL REFERENCES vendors (id),
        building_id          UUID NOT NULL REFERENCES buildings (id),
        space_id             UUID REFERENCES spaces (id),
        relationship_type    TEXT NOT NULL,
        effective_from       TIMESTAMPTZ,
        effective_until      TIMESTAMPTZ,
        status               TEXT NOT NULL DEFAULT 'ACTIVE',
        notes                TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT tenant_contractor_relationship_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT tenant_contractor_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX tenant_contractor_active_context_unique
        ON tenant_contractor_relationships (
          tenant_company_id,
          contractor_vendor_id,
          building_id,
          COALESCE(space_id, '00000000-0000-0000-0000-000000000000'::uuid),
          relationship_type
        )
        WHERE status = 'ACTIVE';
      CREATE INDEX tenant_contractor_tenant_idx
        ON tenant_contractor_relationships
          (tenant_company_id, status, effective_from);
      CREATE INDEX tenant_contractor_building_idx
        ON tenant_contractor_relationships
          (building_id, status, effective_from);
      CREATE INDEX tenant_contractor_vendor_idx
        ON tenant_contractor_relationships
          (contractor_vendor_id, status, effective_from);
      CREATE INDEX tenant_contractor_space_idx
        ON tenant_contractor_relationships (space_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS tenant_contractor_relationships');
  },
};

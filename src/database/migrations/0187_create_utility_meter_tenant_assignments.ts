import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18D — Tenant Meter.
 *
 * Binds an existing BE-18A Meter to an existing BE-14A Tenant Company and
 * BE-04 Space:
 *
 *   Meter → assignment → Tenant Company @ Space
 *
 * There is deliberately NO separate Tenant Meter master. A "tenant meter" is
 * not a different kind of device — it is an ordinary Meter that is currently
 * assigned to a tenant. Creating a parallel master would duplicate meter
 * identity and let the two drift; instead this table records only the
 * assignment, and `utility_meters` is left untouched.
 *
 * `client_id` and `building_id` are denormalised in from the Meter so tenant
 * meter queries can be scoped at the database level
 * (docs/data-isolation.md) instead of being filtered in memory after a global
 * fetch. Both are derived by the service — never accepted from a caller.
 *
 * Constraints encoded here:
 *   - the effective window must not end before it starts,
 *   - a *partial* unique index gives each Meter at most one ACTIVE tenant
 *     assignment at a time, so a meter can never be billed to two tenants at
 *     once, while superseded rows are retained as assignment history.
 *
 * Rules the schema cannot express — Client / Building context, the Space
 * genuinely being leased by that Tenant (BE-14C), and inactive
 * meter / tenant / space rejection — live in the service layer.
 *
 * Main/Sub hierarchy stays owned by BE-18C; this table never references it.
 * Meter Reading (BE-18E) and consumption (BE-18G) are not part of BE-18D, and
 * billing / accounting never lives in BE-18.
 */
export const migration0187CreateUtilityMeterTenantAssignments: Migration = {
  id: '0187_create_utility_meter_tenant_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_meter_tenant_assignments (
        id                UUID PRIMARY KEY,
        client_id         UUID NOT NULL REFERENCES clients (id),
        building_id       UUID NOT NULL REFERENCES buildings (id),
        meter_id          UUID NOT NULL REFERENCES utility_meters (id),
        tenant_company_id UUID NOT NULL REFERENCES tenant_companies (id),
        space_id          UUID NOT NULL REFERENCES spaces (id),
        effective_from    TIMESTAMPTZ,
        effective_until   TIMESTAMPTZ,
        status            TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_meter_tenant_assignments_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT utility_meter_tenant_assignments_effective_range_check
          CHECK (
            effective_from IS NULL
            OR effective_until IS NULL
            OR effective_until >= effective_from
          )
      )
    `);

    // At most one ACTIVE tenant per Meter; INACTIVE history is kept so a
    // tenant change stays auditable.
    await client.query(`
      CREATE UNIQUE INDEX utility_meter_tenant_assignments_active_meter_unique
        ON utility_meter_tenant_assignments (meter_id)
        WHERE status = 'ACTIVE'
    `);

    await client.query(`
      CREATE INDEX utility_meter_tenant_assignments_meter_idx
        ON utility_meter_tenant_assignments (meter_id, status);
      CREATE INDEX utility_meter_tenant_assignments_tenant_idx
        ON utility_meter_tenant_assignments (tenant_company_id, status);
      CREATE INDEX utility_meter_tenant_assignments_space_idx
        ON utility_meter_tenant_assignments (space_id, status);
      CREATE INDEX utility_meter_tenant_assignments_client_idx
        ON utility_meter_tenant_assignments (client_id, building_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(
      'DROP TABLE IF EXISTS utility_meter_tenant_assignments',
    );
  },
};

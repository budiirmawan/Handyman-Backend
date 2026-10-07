import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10E — Engineering Checklist Binding.
 *
 * The minimal Engineering binding that associates a BE-07 Checklist Template
 * with an Engineering operational context: a Building plus an optional
 * BE-05 Asset and/or BE-04 Functional Location target inside that Building.
 *
 * This table holds references only — Checklist Template, Items, Executions,
 * Measurement, Evidence, Verification, and Finding workflow masters are
 * never duplicated. Executions stay BE-07's `checklist_executions` rows.
 *
 * `client_id` is stored directly but derived authoritatively by the service
 * from Building → Property → Client, so isolation can never drift from
 * BE-02. At least one operational target (Asset or Functional Location) is
 * required by CHECK constraint.
 *
 * One ACTIVE binding per (Template, Asset-target, Location-target) is
 * enforced by a partial unique index over COALESCE'd target ids — the same
 * expression-index idiom BE-07 uses for repeatable occurrences.
 */
export const migration0104CreateEngineeringChecklistBindings: Migration = {
  id: '0104_create_engineering_checklist_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE engineering_checklist_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        checklist_template_id  UUID NOT NULL REFERENCES checklist_templates (id),
        asset_id               UUID REFERENCES assets (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT engineering_checklist_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT engineering_checklist_binding_target
          CHECK (asset_id IS NOT NULL OR functional_location_id IS NOT NULL)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX engineering_checklist_binding_active_unique
        ON engineering_checklist_bindings (
          checklist_template_id,
          COALESCE(asset_id, '00000000-0000-0000-0000-000000000000'),
          COALESCE(functional_location_id, '00000000-0000-0000-0000-000000000000')
        )
        WHERE status = 'ACTIVE';
      CREATE INDEX engineering_checklist_bindings_building_idx
        ON engineering_checklist_bindings (building_id, status);
      CREATE INDEX engineering_checklist_bindings_asset_idx
        ON engineering_checklist_bindings (asset_id, status);
      CREATE INDEX engineering_checklist_bindings_template_idx
        ON engineering_checklist_bindings (checklist_template_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS engineering_checklist_bindings');
  },
};

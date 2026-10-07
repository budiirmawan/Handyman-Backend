import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-10B — Equipment Inspection Binding.
 *
 * The minimal Engineering binding that associates an Asset / Equipment
 * (BE-05) with an inspection template (BE-07 Checklist Template) under a
 * Building context. This table holds references only — Asset, Template,
 * Execution, Evidence, and Verification masters are never duplicated.
 *
 * Ownership context is stored directly (`client_id`, `building_id`) but is
 * derived authoritatively by the service from Asset → Building → Property →
 * Client, so isolation can never drift from BE-02.
 *
 * `functional_location_id` is an optional BE-04 location refinement and must
 * resolve to the Asset's own Building (enforced in the service layer).
 *
 * One ACTIVE binding per (Asset, Template) is enforced by a partial unique
 * index — the same BE-07 idiom — so duplicate active bindings are impossible
 * while INACTIVE history is retained.
 */
export const migration0098CreateInspectionBindings: Migration = {
  id: '0098_create_inspection_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE inspection_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        asset_id               UUID NOT NULL REFERENCES assets (id),
        checklist_template_id  UUID NOT NULL REFERENCES checklist_templates (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT inspection_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX inspection_binding_active_unique
        ON inspection_bindings (asset_id, checklist_template_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX inspection_bindings_asset_idx
        ON inspection_bindings (asset_id, status);
      CREATE INDEX inspection_bindings_building_idx
        ON inspection_bindings (building_id, status);
      CREATE INDEX inspection_bindings_template_idx
        ON inspection_bindings (checklist_template_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS inspection_bindings');
  },
};

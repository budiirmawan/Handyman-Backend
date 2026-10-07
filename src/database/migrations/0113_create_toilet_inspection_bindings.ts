import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-11E — Toilet Inspection Binding.
 *
 * The minimal Housekeeping operational binding that associates a Toilet Cleaning Area
 * / location with a shared BE-07 Checklist Template under a Building context.
 *
 * Executions stay shared BE-07 checklist executions — this table holds references
 * only (no duplicate checklist, evidence, verification, or finding engines).
 */
export const migration0113CreateToiletInspectionBindings: Migration = {
  id: '0113_create_toilet_inspection_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE toilet_inspection_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        cleaning_area_id       UUID NOT NULL REFERENCES cleaning_areas (id),
        checklist_template_id  UUID NOT NULL REFERENCES checklist_templates (id),
        room_id                UUID REFERENCES rooms (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        description            TEXT,
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT toilet_inspection_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX toilet_inspection_binding_active_unique
        ON toilet_inspection_bindings (cleaning_area_id, checklist_template_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX toilet_inspection_bindings_area_idx
        ON toilet_inspection_bindings (cleaning_area_id, status);
      CREATE INDEX toilet_inspection_bindings_template_idx
        ON toilet_inspection_bindings (checklist_template_id, status);
      CREATE INDEX toilet_inspection_bindings_building_idx
        ON toilet_inspection_bindings (building_id, status);
      CREATE INDEX toilet_inspection_bindings_client_idx
        ON toilet_inspection_bindings (client_id, status);
      CREATE INDEX toilet_inspection_bindings_room_idx
        ON toilet_inspection_bindings (room_id);
      CREATE INDEX toilet_inspection_bindings_func_loc_idx
        ON toilet_inspection_bindings (functional_location_id);
    `);

    await client.query(`
      ALTER TABLE checklist_executions
        ADD COLUMN toilet_inspection_binding_id UUID REFERENCES toilet_inspection_bindings (id)
    `);

    await client.query(`
      CREATE INDEX checklist_executions_toilet_binding_idx
        ON checklist_executions (toilet_inspection_binding_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS checklist_executions_toilet_binding_idx;
      ALTER TABLE checklist_executions
        DROP COLUMN IF EXISTS toilet_inspection_binding_id;
      DROP TABLE IF EXISTS toilet_inspection_bindings;
    `);
  },
};

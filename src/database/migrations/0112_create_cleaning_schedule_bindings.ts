import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-11B — Cleaning Schedule Binding.
 *
 * Associates a BE-11A Cleaning Area with a shared BE-07 Schedule Definition
 * under a Building context. Recurrence and task generation are delegated to
 * BE-07 without duplication.
 *
 * Client ownership is derived authoritatively from Cleaning Area → Building →
 * Property → Client.
 *
 * At most one ACTIVE binding per (cleaning_area_id, schedule_definition_id)
 * is enforced by a partial unique index.
 */
export const migration0112CreateCleaningScheduleBindings: Migration = {
  id: '0112_create_cleaning_schedule_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE cleaning_schedule_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        cleaning_area_id       UUID NOT NULL REFERENCES cleaning_areas (id),
        schedule_definition_id UUID NOT NULL REFERENCES schedule_definitions (id),
        description            TEXT,
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT cleaning_schedule_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX cleaning_schedule_bindings_active_unique
        ON cleaning_schedule_bindings (cleaning_area_id, schedule_definition_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX cleaning_schedule_bindings_area_idx
        ON cleaning_schedule_bindings (cleaning_area_id, status);
      CREATE INDEX cleaning_schedule_bindings_schedule_idx
        ON cleaning_schedule_bindings (schedule_definition_id);
      CREATE INDEX cleaning_schedule_bindings_building_idx
        ON cleaning_schedule_bindings (building_id, status);
      CREATE INDEX cleaning_schedule_bindings_client_idx
        ON cleaning_schedule_bindings (client_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS cleaning_schedule_bindings');
  },
};

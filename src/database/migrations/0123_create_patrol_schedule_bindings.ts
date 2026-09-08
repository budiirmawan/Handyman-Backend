import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12C — Patrol Schedule Binding.
 *
 * Associates a BE-12B Patrol Route with a shared BE-07 Schedule Definition
 * under a Building context. Recurrence, occurrence preview, and task
 * generation are delegated to BE-07 without duplication. The binding
 * carries an optional `start_security_post_id` (BE-12A) to record the
 * operational Security Post context used when a later BE-12D execution
 * step materialises a Patrol Task.
 *
 * Client ownership is derived authoritatively from Patrol Route → Building
 * → Property → Client. `created_by_user_id` records the actor.
 *
 * At most one ACTIVE binding per (patrol_route_id, schedule_definition_id)
 * is enforced by a partial unique index.
 */
export const migration0123CreatePatrolScheduleBindings: Migration = {
  id: '0123_create_patrol_schedule_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE patrol_schedule_bindings (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        patrol_route_id        UUID NOT NULL REFERENCES patrol_routes (id),
        schedule_definition_id UUID NOT NULL REFERENCES schedule_definitions (id),
        start_security_post_id UUID REFERENCES security_posts (id),
        description            TEXT,
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT patrol_schedule_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX patrol_schedule_bindings_active_unique
        ON patrol_schedule_bindings (patrol_route_id, schedule_definition_id)
        WHERE status = 'ACTIVE';
      CREATE INDEX patrol_schedule_bindings_route_idx
        ON patrol_schedule_bindings (patrol_route_id, status);
      CREATE INDEX patrol_schedule_bindings_schedule_idx
        ON patrol_schedule_bindings (schedule_definition_id);
      CREATE INDEX patrol_schedule_bindings_building_idx
        ON patrol_schedule_bindings (building_id, status);
      CREATE INDEX patrol_schedule_bindings_client_idx
        ON patrol_schedule_bindings (client_id, status);
      CREATE INDEX patrol_schedule_bindings_start_post_idx
        ON patrol_schedule_bindings (start_security_post_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS patrol_schedule_bindings');
  },
};

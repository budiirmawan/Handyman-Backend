import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12D — Patrol Point Visit.
 *
 * Records an ordered checkpoint visit against a BE-07 generated Task
 * (Patrol Execution) for a BE-12B Patrol Route Point. The Task remains
 * authoritative in BE-07 (`generated_tasks.status`); this table only
 * tracks the Security-specific progress through the Route Points.
 *
 * `client_id` / `building_id` are derived from the parent Task and
 * recorded for query convenience. `task_id` (a generated_tasks row) is
 * NOT a hard FK because generated_tasks may be torn down independently
 * (a schema backstop is the partial unique index below — one visit per
 * (task, point)). A point visit is operational history; the row is
 * preserved even if the parent task is later replaced.
 */
export const migration0124CreatePatrolPointVisits: Migration = {
  id: '0124_create_patrol_point_visits',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE patrol_point_visits (
        id                  UUID PRIMARY KEY,
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID NOT NULL REFERENCES buildings (id),
        task_id             UUID NOT NULL,
        patrol_route_id     UUID NOT NULL REFERENCES patrol_routes (id),
        patrol_route_point_id UUID NOT NULL REFERENCES patrol_route_points (id),
        sequence            INTEGER NOT NULL,
        visited_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        visited_by_user_id  UUID NOT NULL REFERENCES users (id),
        notes               TEXT,
        status              TEXT NOT NULL DEFAULT 'VISITED',
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT patrol_point_visits_status_check
          CHECK (status IN ('VISITED', 'INACTIVE')),
        CONSTRAINT patrol_point_visits_sequence_positive
          CHECK (sequence >= 1)
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX patrol_point_visits_task_point_unique
        ON patrol_point_visits (task_id, patrol_route_point_id)
        WHERE status = 'VISITED';
      CREATE INDEX patrol_point_visits_task_id_idx
        ON patrol_point_visits (task_id, sequence);
      CREATE INDEX patrol_point_visits_route_id_idx
        ON patrol_point_visits (patrol_route_id);
      CREATE INDEX patrol_point_visits_building_id_idx
        ON patrol_point_visits (building_id);
      CREATE INDEX patrol_point_visits_client_id_idx
        ON patrol_point_visits (client_id, visited_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS patrol_point_visits');
  },
};

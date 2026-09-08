import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12B — Patrol Route foundation.
 *
 * A Patrol Route is an ordered, named Security patrol definition anchored
 * to one Building. It may optionally bind to a starting BE-12A Security
 * Post (which must belong to the same Building).
 *
 * A Patrol Route is operational context only — it does NOT carry any
 * scheduling, recurrence, task generation, assignment, execution,
 * checklist, evidence, finding, incident, or reporting semantics. Those
 * belong to later BE-12 PARTs.
 *
 * Client ownership is derived authoritatively through Patrol Route →
 * Building → Property → Client. `code` is normalized and unique per
 * Building (`building_id + code`).
 */
export const migration0121CreatePatrolRoutes: Migration = {
  id: '0121_create_patrol_routes',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE patrol_routes (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        start_security_post_id UUID REFERENCES security_posts (id),
        code                  TEXT NOT NULL,
        name                  TEXT NOT NULL,
        description           TEXT,
        status                TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT patrol_routes_building_code_unique
          UNIQUE (building_id, code),
        CONSTRAINT patrol_routes_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX patrol_routes_building_id_idx
        ON patrol_routes (building_id, status);
      CREATE INDEX patrol_routes_client_id_idx
        ON patrol_routes (client_id, status);
      CREATE INDEX patrol_routes_start_security_post_id_idx
        ON patrol_routes (start_security_post_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS patrol_routes');
  },
};

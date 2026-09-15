import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12B — Patrol Route Point foundation.
 *
 * A Patrol Route Point is an ordered stop on a Patrol Route. It references
 * exactly one authoritative BE-04 location record (Area, Room, or
 * Functional Location) which must belong to the same Building as the
 * parent Patrol Route.
 *
 * Location details are NEVER duplicated into the route point — only the
 * reference (and optional `notes`) is stored. Client/Building isolation
 * is enforced by service-layer validation against the parent route's
 * Building; the FK indexes here are the schema backstop.
 *
 * `sequence` is a positive integer and must be unique within one
 * Patrol Route. The (route_id, sequence) uniqueness is the final
 * authority for ordering; concurrent inserts that would collide are
 * caught by the unique index.
 */
export const migration0122CreatePatrolRoutePoints: Migration = {
  id: '0122_create_patrol_route_points',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE patrol_route_points (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        patrol_route_id        UUID NOT NULL REFERENCES patrol_routes (id),
        floor_id               UUID REFERENCES floors (id),
        area_id                UUID REFERENCES areas (id),
        room_id                UUID REFERENCES rooms (id),
        space_id               UUID REFERENCES spaces (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        sequence               INTEGER NOT NULL,
        notes                  TEXT,
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT patrol_route_points_route_sequence_unique
          UNIQUE (patrol_route_id, sequence),
        CONSTRAINT patrol_route_points_sequence_positive
          CHECK (sequence >= 1),
        CONSTRAINT patrol_route_points_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX patrol_route_points_route_id_idx
        ON patrol_route_points (patrol_route_id, sequence);
      CREATE INDEX patrol_route_points_building_id_idx
        ON patrol_route_points (building_id);
      CREATE INDEX patrol_route_points_area_id_idx
        ON patrol_route_points (area_id);
      CREATE INDEX patrol_route_points_room_id_idx
        ON patrol_route_points (room_id);
      CREATE INDEX patrol_route_points_space_id_idx
        ON patrol_route_points (space_id);
      CREATE INDEX patrol_route_points_functional_location_id_idx
        ON patrol_route_points (functional_location_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS patrol_route_points');
  },
};

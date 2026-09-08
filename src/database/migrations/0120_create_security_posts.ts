import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-12A — Security Post foundation.
 *
 * A Security Post represents an operational Security duty/post location
 * anchored to the building digital structure (Building → Floor / Area /
 * Room / Space / Functional Location). It is NOT a duplicate location
 * hierarchy; the post merely records a name, code, type, and an optional
 * authoritative location reference for a Security operation.
 *
 * Client ownership is derived authoritatively from Building → Property →
 * Client. `code` is normalized and unique per Building
 * (`building_id + code`).
 */
export const migration0120CreateSecurityPosts: Migration = {
  id: '0120_create_security_posts',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE security_posts (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        floor_id               UUID REFERENCES floors (id),
        area_id                UUID REFERENCES areas (id),
        room_id                UUID REFERENCES rooms (id),
        space_id               UUID REFERENCES spaces (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        code                   TEXT NOT NULL,
        name                   TEXT NOT NULL,
        description            TEXT,
        post_type              TEXT NOT NULL DEFAULT 'GENERAL',
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT security_posts_building_code_unique
          UNIQUE (building_id, code),
        CONSTRAINT security_posts_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT security_posts_type_check
          CHECK (post_type IN (
            'GENERAL', 'LOBBY', 'GATE', 'PERIMETER', 'PARKING',
            'CONTROL_ROOM', 'PATROL', 'STANDBY', 'OTHER'
          ))
      )
    `);

    await client.query(`
      CREATE INDEX security_posts_building_id_idx
        ON security_posts (building_id, status);
      CREATE INDEX security_posts_client_id_idx
        ON security_posts (client_id, status);
      CREATE INDEX security_posts_floor_id_idx
        ON security_posts (floor_id);
      CREATE INDEX security_posts_area_id_idx
        ON security_posts (area_id);
      CREATE INDEX security_posts_room_id_idx
        ON security_posts (room_id);
      CREATE INDEX security_posts_space_id_idx
        ON security_posts (space_id);
      CREATE INDEX security_posts_functional_location_id_idx
        ON security_posts (functional_location_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS security_posts');
  },
};

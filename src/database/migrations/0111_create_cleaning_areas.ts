import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-11A — Cleaning Area foundation.
 *
 * A Cleaning Area represents a Housekeeping operational cleaning scope
 * anchored to the building structure (Building → Floor / Area / Room / Space
 * / Functional Location).
 *
 * Location references point directly to authoritative BE-04 structure records
 * without duplicating physical hierarchy details. Client ownership is
 * derived authoritatively from Building → Property → Client.
 *
 * `code` is normalized and unique per Building (`building_id + code`).
 */
export const migration0111CreateCleaningAreas: Migration = {
  id: '0111_create_cleaning_areas',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE cleaning_areas (
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
        cleaning_area_type     TEXT NOT NULL DEFAULT 'GENERAL',
        status                 TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT cleaning_areas_building_code_unique
          UNIQUE (building_id, code),
        CONSTRAINT cleaning_areas_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT cleaning_areas_type_check
          CHECK (cleaning_area_type IN (
            'GENERAL', 'ROOM', 'TOILET', 'PUBLIC_AREA',
            'OFFICE', 'CORRIDOR', 'OUTDOOR', 'OTHER'
          ))
      )
    `);

    await client.query(`
      CREATE INDEX cleaning_areas_building_id_idx
        ON cleaning_areas (building_id, status);
      CREATE INDEX cleaning_areas_client_id_idx
        ON cleaning_areas (client_id, status);
      CREATE INDEX cleaning_areas_floor_id_idx
        ON cleaning_areas (floor_id);
      CREATE INDEX cleaning_areas_area_id_idx
        ON cleaning_areas (area_id);
      CREATE INDEX cleaning_areas_room_id_idx
        ON cleaning_areas (room_id);
      CREATE INDEX cleaning_areas_space_id_idx
        ON cleaning_areas (space_id);
      CREATE INDEX cleaning_areas_functional_location_id_idx
        ON cleaning_areas (functional_location_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS cleaning_areas');
  },
};

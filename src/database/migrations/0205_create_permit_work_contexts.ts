import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-20D — Work Location / Type.
 *
 * One work-context row belongs to one BE-20C Application. Location columns are
 * references to the authoritative BE-04 digital structure; no location names
 * or hierarchy are copied. Location and Work Type may be assigned in either
 * order while the Application remains DRAFT. Once submitted, the service
 * protects the row from overwrite and the references remain as history.
 */
export const migration0205CreatePermitWorkContexts: Migration = {
  id: '0205_create_permit_work_contexts',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE permit_work_contexts (
        id                     UUID PRIMARY KEY,
        permit_application_id  UUID NOT NULL REFERENCES permit_applications (id),
        location_type          TEXT,
        building_id            UUID REFERENCES buildings (id),
        floor_id               UUID REFERENCES floors (id),
        area_id                UUID REFERENCES areas (id),
        room_id                UUID REFERENCES rooms (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        work_type              TEXT,
        work_description       TEXT,
        planned_start_at       TIMESTAMPTZ,
        planned_end_at         TIMESTAMPTZ,
        access_restriction_notes TEXT,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        updated_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permit_work_contexts_application_unique
          UNIQUE (permit_application_id),
        CONSTRAINT permit_work_contexts_location_type_check
          CHECK (location_type IS NULL OR location_type IN (
            'BUILDING', 'FLOOR', 'AREA', 'ROOM', 'FUNCTIONAL_LOCATION'
          )),
        CONSTRAINT permit_work_contexts_location_reference_check
          CHECK (
            (location_type IS NULL
              AND building_id IS NULL
              AND floor_id IS NULL
              AND area_id IS NULL
              AND room_id IS NULL
              AND functional_location_id IS NULL)
            OR
            (location_type = 'BUILDING'
              AND building_id IS NOT NULL
              AND floor_id IS NULL AND area_id IS NULL AND room_id IS NULL
              AND functional_location_id IS NULL)
            OR
            (location_type = 'FLOOR'
              AND building_id IS NULL
              AND floor_id IS NOT NULL
              AND area_id IS NULL AND room_id IS NULL
              AND functional_location_id IS NULL)
            OR
            (location_type = 'AREA'
              AND building_id IS NULL AND floor_id IS NULL
              AND area_id IS NOT NULL
              AND room_id IS NULL AND functional_location_id IS NULL)
            OR
            (location_type = 'ROOM'
              AND building_id IS NULL AND floor_id IS NULL AND area_id IS NULL
              AND room_id IS NOT NULL AND functional_location_id IS NULL)
            OR
            (location_type = 'FUNCTIONAL_LOCATION'
              AND building_id IS NULL AND floor_id IS NULL
              AND area_id IS NULL AND room_id IS NULL
              AND functional_location_id IS NOT NULL)
          ),
        CONSTRAINT permit_work_contexts_content_check
          CHECK (location_type IS NOT NULL OR work_type IS NOT NULL),
        CONSTRAINT permit_work_contexts_planned_pair_check
          CHECK (
            (planned_start_at IS NULL AND planned_end_at IS NULL)
            OR
            (planned_start_at IS NOT NULL AND planned_end_at IS NOT NULL
              AND planned_end_at > planned_start_at)
          )
      )
    `);

    await client.query(`
      CREATE INDEX permit_work_contexts_work_type_idx
        ON permit_work_contexts (work_type);
      CREATE INDEX permit_work_contexts_building_idx
        ON permit_work_contexts (building_id);
      CREATE INDEX permit_work_contexts_floor_idx
        ON permit_work_contexts (floor_id);
      CREATE INDEX permit_work_contexts_area_idx
        ON permit_work_contexts (area_id);
      CREATE INDEX permit_work_contexts_room_idx
        ON permit_work_contexts (room_id);
      CREATE INDEX permit_work_contexts_functional_location_idx
        ON permit_work_contexts (functional_location_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permit_work_contexts');
  },
};

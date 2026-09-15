import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-11H — Housekeeping Finding / Re-clean / Rework Binding.
 *
 * Records the Housekeeping operational source and location context for a
 * shared BE-09 Finding. The Finding lifecycle, assignments, review, rework
 * cycles, closure, and available actions are driven entirely through BE-09.
 */
export const migration0116CreateHousekeepingFindingLinks: Migration = {
  id: '0116_create_housekeeping_finding_links',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE housekeeping_finding_links (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        finding_id             UUID NOT NULL UNIQUE REFERENCES findings (id),
        cleaning_area_id       UUID NOT NULL REFERENCES cleaning_areas (id),
        source_type            TEXT NOT NULL,
        source_id              UUID NOT NULL,
        floor_id               UUID REFERENCES floors (id),
        area_id                UUID REFERENCES areas (id),
        room_id                UUID REFERENCES rooms (id),
        functional_location_id UUID REFERENCES functional_locations (id),
        notes                  TEXT,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT housekeeping_finding_source_type
          CHECK (source_type IN (
            'DAILY_CLEANING', 'TOILET_INSPECTION',
            'PUBLIC_AREA_INSPECTION', 'SUPERVISOR_INSPECTION'
          ))
      )
    `);

    await client.query(`
      CREATE INDEX housekeeping_finding_links_building_idx
        ON housekeeping_finding_links (building_id);
      CREATE INDEX housekeeping_finding_links_area_idx
        ON housekeeping_finding_links (cleaning_area_id);
      CREATE INDEX housekeeping_finding_links_finding_idx
        ON housekeeping_finding_links (finding_id);
      CREATE INDEX housekeeping_finding_links_source_idx
        ON housekeeping_finding_links (source_type, source_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS housekeeping_finding_links');
  },
};

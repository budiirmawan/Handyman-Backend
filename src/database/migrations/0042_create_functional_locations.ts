import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-04G — Functional Location foundation.
 *
 * A Functional Location is an OPERATIONAL LOCATION REFERENCE anchored to the
 * digital building structure. It always belongs to exactly one Building and
 * may optionally pin itself to a specific Space (Building → Floor →
 * Area/Zone → Room → Space → Functional Location) when a finer physical
 * context applies. Client ownership is derived authoritatively through
 * Functional Location → Building → Property → Client.
 *
 * `building_id` is stored directly (unlike the intermediate structure
 * levels) because a Functional Location is Building-scoped by definition —
 * its code is unique per Building (`building_id + code`) and it may exist
 * without any finer placement. When `space_id` is set, the service layer
 * enforces that the Space resolves to the SAME Building (the FK guarantees
 * referential integrity only).
 *
 * A Functional Location is NOT an Asset, Equipment, Asset hierarchy, Work
 * Order, Checklist, or Task — and it carries NO Asset binding (deferred
 * beyond BE-04). Inactive Functional Locations remain persisted — never
 * hard-deleted through normal lifecycle operations.
 */
export const migration0042CreateFunctionalLocations: Migration = {
  id: '0042_create_functional_locations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE functional_locations (
        id          UUID PRIMARY KEY,
        building_id UUID NOT NULL,
        space_id    UUID,
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        description TEXT,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT functional_locations_building_id_fkey
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT functional_locations_space_id_fkey
          FOREIGN KEY (space_id) REFERENCES spaces (id),
        CONSTRAINT functional_locations_building_code_unique
          UNIQUE (building_id, code),
        CONSTRAINT functional_locations_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(
      `CREATE INDEX functional_locations_building_id_idx
         ON functional_locations (building_id)`,
    );
    await client.query(
      `CREATE INDEX functional_locations_space_id_idx
         ON functional_locations (space_id)`,
    );
    await client.query(
      `CREATE INDEX functional_locations_status_idx
         ON functional_locations (status)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS functional_locations');
  },
};

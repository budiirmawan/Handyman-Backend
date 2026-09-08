import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-04B — Optional Building → Campus reference.
 *
 * Adds the minimal association enabling Property → Campus → Building where a
 * Property uses campuses. `campus_id` is NULLABLE and defaults to NULL, so
 * every existing Building (and every Building in a campus-less Property)
 * remains valid without change: Property → Building keeps working as-is.
 *
 * Same-Property integrity (a Building may only join a Campus of its own
 * Property) is a business rule enforced by the service layer, where it also
 * yields the proper API error — the FK here guarantees referential integrity
 * only.
 */
export const migration0036AddBuildingCampusReference: Migration = {
  id: '0036_add_building_campus_reference',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE buildings
        ADD COLUMN campus_id UUID,
        ADD CONSTRAINT buildings_campus_id_fkey
          FOREIGN KEY (campus_id) REFERENCES campuses (id)
    `);

    await client.query(
      `CREATE INDEX buildings_campus_id_idx ON buildings (campus_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE buildings
        DROP CONSTRAINT IF EXISTS buildings_campus_id_fkey,
        DROP COLUMN IF EXISTS campus_id
    `);
  },
};

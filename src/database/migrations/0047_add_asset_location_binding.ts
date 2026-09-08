import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-05C — Asset → Functional Location binding.
 *
 * ONE nullable reference is added. The Asset already carries `building_id`
 * (BE-05A), which remains the minimum direct location reference when no
 * Functional Location is assigned yet; everything finer —
 * Floor → Area/Zone → Room → Space — is RESOLVED authoritatively from the
 * BE-04 structure through the Functional Location, never copied onto the
 * Asset. Duplicating the hierarchy here would create a second source of
 * truth that could silently drift from BE-04.
 *
 * No Building Digital Structure table is created or modified: this migration
 * only points the Asset at the existing `functional_locations` foundation.
 *
 * `functional_location_id` is NULLABLE and defaults to NULL, so every Asset
 * registered under BE-05A remains valid and Building-level-only binding stays
 * legitimate.
 *
 * The business rules — the Functional Location must resolve to the SAME
 * Building as the Asset (and therefore the same Client), and an inactive
 * location may not receive a new active binding — are enforced by the service
 * layer using the BE-04H resolver, where they also yield the proper API
 * error. The FK here guarantees referential integrity only.
 */
export const migration0047AddAssetLocationBinding: Migration = {
  id: '0047_add_asset_location_binding',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE assets
        ADD COLUMN functional_location_id UUID,
        ADD CONSTRAINT assets_functional_location_id_fkey
          FOREIGN KEY (functional_location_id)
          REFERENCES functional_locations (id)
    `);

    await client.query(
      `CREATE INDEX assets_functional_location_id_idx
         ON assets (functional_location_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE assets
        DROP CONSTRAINT IF EXISTS assets_functional_location_id_fkey,
        DROP COLUMN IF EXISTS functional_location_id
    `);
  },
};

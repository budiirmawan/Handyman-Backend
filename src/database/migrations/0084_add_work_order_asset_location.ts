import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-08D — Work Order → Asset / Location binding.
 *
 * A Work Order may be Asset-based, Location-based, or both:
 *   - `asset_id`             nullable FK to the BE-05 Asset Registry
 *   - `functional_location_id` nullable FK to the BE-04 Functional Location
 *
 * Both references stay OPTIONAL and are validated against the Work Order's own
 * Building at the service layer (no duplicated Asset / location masters —
 * these are pure references). The FKs guarantee referential integrity only;
 * cross-Building / cross-Client and hierarchy-consistency rules are enforced
 * by the service using the existing BE-04/05 resolvers.
 */
export const migration0084AddWorkOrderAssetLocation: Migration = {
  id: '0084_add_work_order_asset_location',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE work_orders
        ADD COLUMN asset_id UUID REFERENCES assets (id),
        ADD COLUMN functional_location_id UUID REFERENCES functional_locations (id)
    `);

    await client.query(`
      CREATE INDEX work_orders_asset_idx
        ON work_orders (asset_id);
      CREATE INDEX work_orders_functional_location_idx
        ON work_orders (functional_location_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE work_orders
        DROP COLUMN asset_id,
        DROP COLUMN functional_location_id
    `);
  },
};

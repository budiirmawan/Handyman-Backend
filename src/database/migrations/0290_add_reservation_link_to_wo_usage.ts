import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-INV-CONTROL-01 PART 02 — reservation-to-usage linkage.
 *
 * Adds the optional reservation reference to existing Work Order material
 * usage rows. Nullable preserves historical usages and the existing usage
 * authority; PART 02 writes it only for reservation-backed controlled issues.
 */
export const migration0290AddReservationLinkToWoUsage: Migration = {
  id: '0290_add_reservation_link_to_wo_usage',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE inventory_work_order_material_usages
        ADD COLUMN reservation_id UUID
          REFERENCES inventory_material_reservations (id)
    `);

    await client.query(`
      CREATE INDEX inventory_wo_usage_reservation_idx
        ON inventory_work_order_material_usages (reservation_id, used_at DESC)
        WHERE reservation_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS inventory_wo_usage_reservation_idx;
      ALTER TABLE inventory_work_order_material_usages
        DROP COLUMN IF EXISTS reservation_id
    `);
  },
};

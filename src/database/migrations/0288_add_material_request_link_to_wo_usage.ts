import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-INV-CONTROL-01 PART 01 — controlled usage source link.
 *
 * Material Reservation demand calculations need a stable way to distinguish
 * Work Order usage rows attributed to a Material Request. The column is
 * nullable so all historical usage rows remain valid and unchanged. This
 * migration does not change the issue endpoint or add issue-consumption
 * behavior; PART 02 owns writing the link for new controlled issues.
 */
export const migration0288AddMaterialRequestLinkToWoUsage: Migration = {
  id: '0288_add_material_request_link_to_wo_usage',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE inventory_work_order_material_usages
        ADD COLUMN material_request_id UUID REFERENCES material_requests (id)
    `);

    await client.query(`
      CREATE INDEX inventory_wo_usage_material_request_idx
        ON inventory_work_order_material_usages (material_request_id, used_at DESC)
        WHERE material_request_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS inventory_wo_usage_material_request_idx;
      ALTER TABLE inventory_work_order_material_usages
        DROP COLUMN IF EXISTS material_request_id
    `);
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-MAT-01 PART 06 — Work Order Material Issue Control.
 *
 * Adds the stable linkage between a Work Order Material Usage (BE-16I) and
 * the STOCK_OUT ledger movement that issued the stock (PART 03 authority):
 *
 *   Work Order → Item → Warehouse → STOCK_OUT → Work Order Material Usage
 *
 * `stock_movement_id` mirrors the existing `receivings.stock_movement_id`
 * convention (PART 01). Nullable so historical usages (linked only by the
 * movement's `source = 'WORK_ORDER:{id}'` text convention) stay untouched —
 * no backfill, no rewrite. No new Stock Out / usage / reservation engine.
 */
export const migration0268AddWoMaterialUsageMovementLink: Migration = {
  id: '0268_add_wo_material_usage_movement_link',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE inventory_work_order_material_usages
        ADD COLUMN stock_movement_id UUID REFERENCES inventory_stock_movements (id)
    `);
    await client.query(`
      CREATE INDEX inventory_wo_usage_stock_movement_idx
        ON inventory_work_order_material_usages (stock_movement_id)
        WHERE stock_movement_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP INDEX IF EXISTS inventory_wo_usage_stock_movement_idx;
      ALTER TABLE inventory_work_order_material_usages
        DROP COLUMN IF EXISTS stock_movement_id
    `);
  },
};

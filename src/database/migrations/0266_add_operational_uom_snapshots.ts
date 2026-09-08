import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-MAT-01 PART 04 — Material UOM Snapshot.
 *
 * Operational material transactions must preserve the UOM context that
 * applied when the quantity was requested, received, moved, or issued —
 * reading history must not depend solely on the CURRENT (mutable) Inventory
 * Item UOM.
 *
 * Follows the existing project convention (stable `units_of_measure` FK ids,
 * as already used by `material_requests.uom_id`, `form_fields`,
 * `checklist_items`) — no new UOM master, no code/name duplication, no
 * conversion engine. Columns are nullable so historical rows stay untouched
 * and readable (legacy fallback = the item's UOM); no backfill is performed.
 *
 * - `inventory_stock_movements.uom_id`               — UOM at movement time
 * - `receivings.uom_id`                              — UOM at receipt time
 * - `inventory_work_order_material_usages.uom_id`    — UOM at issue/use time
 *
 * `material_requests.uom_id` already exists (BE-17B) and is frozen after
 * approval by PART 02.
 */
export const migration0266AddOperationalUomSnapshots: Migration = {
  id: '0266_add_operational_uom_snapshots',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE inventory_stock_movements
        ADD COLUMN uom_id UUID REFERENCES units_of_measure (id)
    `);
    await client.query(`
      ALTER TABLE receivings
        ADD COLUMN uom_id UUID REFERENCES units_of_measure (id)
    `);
    await client.query(`
      ALTER TABLE inventory_work_order_material_usages
        ADD COLUMN uom_id UUID REFERENCES units_of_measure (id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE inventory_work_order_material_usages DROP COLUMN IF EXISTS uom_id;
      ALTER TABLE receivings DROP COLUMN IF EXISTS uom_id;
      ALTER TABLE inventory_stock_movements DROP COLUMN IF EXISTS uom_id;
    `);
  },
};

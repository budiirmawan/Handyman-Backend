import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-MAT-01 PART 05 — Work Order Operational Material Cost.
 *
 * Adds an OPERATIONAL cost snapshot to the existing Work Order Material Usage
 * record (BE-16I). This is a read/calculation concern only — NO inventory
 * accounting, GL, valuation (weighted average / FIFO / LIFO / standard),
 * purchase-price variance, or AP.
 *
 * No existing authoritative unit cost exists in procurement/receiving (audit:
 * no price data anywhere in the chain), so the operational unit cost is
 * snapshotted on the usage row at issue/use time:
 *
 * - `unit_cost`      — NUMERIC ≥ 0 (existing decimal money convention).
 * - `total_cost`     — GENERATED ALWAYS AS (quantity * unit_cost) STORED, so
 *                      total = quantity × unit cost is computed in NUMERIC
 *                      (no float drift) and can never diverge from its parts.
 * - `currency`       — optional ISO 4217 code (same list as BE-23 vendor
 *                      invoices, the existing currency convention).
 * - `cost_source` / `cost_reference` — provenance of the operational cost.
 *
 * `recorded_at` is the existing append-only `created_at` / `used_at` pair.
 * Rows are immutable, so the snapshot is stable: later item/supplier price
 * changes never rewrite historical Work Order cost. Columns are nullable —
 * historical and cost-less usages stay valid (no backfill).
 */
export const migration0267AddWoMaterialUsageCost: Migration = {
  id: '0267_add_wo_material_usage_cost',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE inventory_work_order_material_usages
        ADD COLUMN unit_cost      NUMERIC,
        ADD COLUMN total_cost     NUMERIC GENERATED ALWAYS AS (quantity * unit_cost) STORED,
        ADD COLUMN currency       TEXT,
        ADD COLUMN cost_source    TEXT,
        ADD COLUMN cost_reference TEXT,
        ADD CONSTRAINT wo_usage_unit_cost_non_negative
          CHECK (unit_cost IS NULL OR unit_cost >= 0),
        ADD CONSTRAINT wo_usage_currency_check
          CHECK (
            currency IS NULL
            OR currency IN ('IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY')
          ),
        ADD CONSTRAINT wo_usage_currency_requires_cost
          CHECK (currency IS NULL OR unit_cost IS NOT NULL),
        ADD CONSTRAINT wo_usage_cost_source_requires_cost
          CHECK (cost_source IS NULL OR unit_cost IS NOT NULL)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE inventory_work_order_material_usages
        DROP CONSTRAINT IF EXISTS wo_usage_cost_source_requires_cost,
        DROP CONSTRAINT IF EXISTS wo_usage_currency_requires_cost,
        DROP CONSTRAINT IF EXISTS wo_usage_currency_check,
        DROP CONSTRAINT IF EXISTS wo_usage_unit_cost_non_negative,
        DROP COLUMN IF EXISTS cost_reference,
        DROP COLUMN IF EXISTS cost_source,
        DROP COLUMN IF EXISTS currency,
        DROP COLUMN IF EXISTS total_cost,
        DROP COLUMN IF EXISTS unit_cost
    `);
  },
};

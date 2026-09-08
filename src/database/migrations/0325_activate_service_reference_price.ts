import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-SVC-01 PART 05 — SERVICE Reference Price Activation.
 *
 * Activates SERVICE pricing in the existing PRICE-01 reference-price
 * authority (`price_catalog_entries`) using the governed `service_catalog`
 * identity established in PART 01–04 (`docs/CR-BE-SVC-01_START_GOVERNANCE.md`
 * §10). This is deliberately NOT "just flip source_mode": SERVICE has a
 * different subject cardinality (no item, no UOM, no quantity).
 *
 * price_catalog_entries:
 *   - `source_mode` CHECK widened to admit `SERVICE`.
 *   - `item_id` / `uom_id` become NULLABLE; new `service_id` column.
 *   - A discriminated-union shape CHECK enforces mode-correct nullness:
 *       MATERIAL ⇒ item_id + uom_id NOT NULL, service_id NULL
 *       SERVICE  ⇒ service_id NOT NULL, item_id + uom_id NULL
 *   - Composite scope FK `(service_id, client_id) → service_catalog`.
 *   - The single ACTIVE-window exclusion is SPLIT into two partial
 *     constraints — MATERIAL (item/uom/currency/...) and SERVICE
 *     (service/currency/... — NO uom). MATERIAL pricing stays byte-identical:
 *     the MATERIAL constraint is the old one narrowed by an additive
 *     `source_mode = 'MATERIAL'` qualifier that excludes zero rows today.
 *
 * rfq_comparison_lines:
 *   - The reference-shape CHECK is relaxed to be mode-aware: a SERVICE MATCH
 *     carries the unit facts + unit variance/percent/position but NULL
 *     reference_uom_id / reference_total / total_variance (SERVICE has no
 *     governed quantity). MATERIAL MATCH keeps the full quantity-based shape.
 *
 * No FX, no quantity for SERVICE, no pricing gate, no commitment change.
 */
export const migration0325ActivateServiceReferencePrice: Migration = {
  id: '0325_activate_service_reference_price',

  async up(client: PoolClient): Promise<void> {
    // --- price_catalog_entries: widen to admit SERVICE ---
    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD COLUMN service_id UUID
    `);

    await client.query(`
      ALTER TABLE price_catalog_entries
        ALTER COLUMN item_id DROP NOT NULL,
        ALTER COLUMN uom_id DROP NOT NULL
    `);

    await client.query(`
      ALTER TABLE price_catalog_entries
        DROP CONSTRAINT price_catalog_entries_source_mode_check
    `);
    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD CONSTRAINT price_catalog_entries_source_mode_check
          CHECK (source_mode IN ('MATERIAL', 'SERVICE'))
    `);

    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD CONSTRAINT price_catalog_entries_service_scope_fk
          FOREIGN KEY (service_id, client_id)
          REFERENCES service_catalog (id, client_id)
    `);

    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD CONSTRAINT price_catalog_entries_subject_shape_check
          CHECK (
            (source_mode = 'MATERIAL'
              AND item_id IS NOT NULL AND uom_id IS NOT NULL
              AND service_id IS NULL)
            OR (source_mode = 'SERVICE'
              AND service_id IS NOT NULL
              AND item_id IS NULL AND uom_id IS NULL)
          )
    `);

    // Split the ACTIVE-window exclusion into two mode-scoped partials.
    await client.query(`
      ALTER TABLE price_catalog_entries
        DROP CONSTRAINT price_catalog_entries_active_window_exclusion
    `);
    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD CONSTRAINT price_catalog_entries_material_window_exclusion
        EXCLUDE USING gist (
          client_id WITH =,
          item_id   WITH =,
          uom_id    WITH =,
          currency  WITH =,
          COALESCE(building_id,
            '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
          COALESCE(vendor_id,
            '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
          tstzrange(effective_from, effective_to, '[)') WITH &&
        )
        WHERE (status = 'ACTIVE' AND source_mode = 'MATERIAL')
    `);
    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD CONSTRAINT price_catalog_entries_service_window_exclusion
        EXCLUDE USING gist (
          client_id WITH =,
          service_id WITH =,
          currency  WITH =,
          COALESCE(building_id,
            '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
          COALESCE(vendor_id,
            '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
          tstzrange(effective_from, effective_to, '[)') WITH &&
        )
        WHERE (status = 'ACTIVE' AND source_mode = 'SERVICE')
    `);

    await client.query(`
      CREATE INDEX price_catalog_entries_service_resolution_idx
        ON price_catalog_entries
          (client_id, service_id, currency, building_id, vendor_id,
           effective_from DESC)
        WHERE status = 'ACTIVE' AND source_mode = 'SERVICE'
    `);

    // --- rfq_comparison_lines: mode-aware reference shape CHECK ---
    await client.query(`
      ALTER TABLE rfq_comparison_lines
        DROP CONSTRAINT rfq_comparison_lines_reference_shape_check
    `);
    await client.query(`
      ALTER TABLE rfq_comparison_lines
        ADD CONSTRAINT rfq_comparison_lines_reference_shape_check CHECK (
          (
            reference_resolution = 'MATCHED'
            AND reference_price_entry_id IS NOT NULL
            AND reference_unit_price IS NOT NULL
            AND reference_unit_price > 0
            AND reference_currency IS NOT NULL
            AND reference_scope_vendor IS NOT NULL
            AND reference_scope_building IS NOT NULL
            AND reference_effective_from IS NOT NULL
            AND unit_variance IS NOT NULL
            AND variance_percent IS NOT NULL
            AND position_vs_reference IS NOT NULL
            AND (
              (source_mode = 'MATERIAL'
                AND reference_uom_id IS NOT NULL
                AND reference_total IS NOT NULL
                AND reference_total >= 0
                AND total_variance IS NOT NULL)
              OR (source_mode = 'SERVICE'
                AND reference_uom_id IS NULL
                AND reference_total IS NULL
                AND total_variance IS NULL)
            )
          )
          OR (
            (
              reference_resolution IS NULL
              OR reference_resolution IN (
                'NO_REFERENCE_PRICE', 'UOM_INCOMPATIBLE',
                'CURRENCY_INCOMPATIBLE', 'NOT_REQUESTED'
              )
            )
            AND reference_price_entry_id IS NULL
            AND reference_unit_price IS NULL
            AND reference_currency IS NULL
            AND reference_uom_id IS NULL
            AND reference_scope_vendor IS NULL
            AND reference_scope_building IS NULL
            AND reference_effective_from IS NULL
            AND reference_total IS NULL
            AND unit_variance IS NULL
            AND total_variance IS NULL
            AND variance_percent IS NULL
            AND position_vs_reference IS NULL
          )
        )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    // Best-effort downgrade: restore the MATERIAL-only authority shape.
    await client.query(
      `ALTER TABLE rfq_comparison_lines
         DROP CONSTRAINT IF EXISTS rfq_comparison_lines_reference_shape_check`,
    );
    // Re-add the original single-shape CHECK (MATERIAL-only MATCHED).
    await client.query(`
      ALTER TABLE rfq_comparison_lines
        ADD CONSTRAINT rfq_comparison_lines_reference_shape_check CHECK (
          (reference_resolution = 'MATCHED'
            AND reference_price_entry_id IS NOT NULL
            AND reference_unit_price IS NOT NULL AND reference_unit_price > 0
            AND reference_currency IS NOT NULL AND reference_uom_id IS NOT NULL
            AND reference_scope_vendor IS NOT NULL AND reference_scope_building IS NOT NULL
            AND reference_effective_from IS NOT NULL
            AND reference_total IS NOT NULL AND reference_total >= 0
            AND unit_variance IS NOT NULL AND total_variance IS NOT NULL
            AND variance_percent IS NOT NULL AND position_vs_reference IS NOT NULL)
          OR ((reference_resolution IS NULL OR reference_resolution IN
                ('NO_REFERENCE_PRICE','UOM_INCOMPATIBLE','CURRENCY_INCOMPATIBLE','NOT_REQUESTED'))
            AND reference_price_entry_id IS NULL AND reference_unit_price IS NULL
            AND reference_currency IS NULL AND reference_uom_id IS NULL
            AND reference_scope_vendor IS NULL AND reference_scope_building IS NULL
            AND reference_effective_from IS NULL AND reference_total IS NULL
            AND unit_variance IS NULL AND total_variance IS NULL
            AND variance_percent IS NULL AND position_vs_reference IS NULL)
        )
    `);
    await client.query(
      `DROP INDEX IF EXISTS price_catalog_entries_service_resolution_idx`,
    );
    await client.query(
      `ALTER TABLE price_catalog_entries
         DROP CONSTRAINT IF EXISTS price_catalog_entries_service_window_exclusion`,
    );
    await client.query(
      `ALTER TABLE price_catalog_entries
         DROP CONSTRAINT IF EXISTS price_catalog_entries_material_window_exclusion`,
    );
    // Re-add the original single exclusion (MATERIAL only, no qualifier).
    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD CONSTRAINT price_catalog_entries_active_window_exclusion
        EXCLUDE USING gist (
          client_id WITH =, item_id WITH =, uom_id WITH =, currency WITH =,
          COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
          COALESCE(vendor_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =,
          tstzrange(effective_from, effective_to, '[)') WITH &&
        ) WHERE (status = 'ACTIVE')
    `);
    await client.query(
      `ALTER TABLE price_catalog_entries
         DROP CONSTRAINT IF EXISTS price_catalog_entries_subject_shape_check`,
    );
    await client.query(
      `ALTER TABLE price_catalog_entries
         DROP CONSTRAINT IF EXISTS price_catalog_entries_service_scope_fk`,
    );
    await client.query(
      `ALTER TABLE price_catalog_entries
         DROP CONSTRAINT IF EXISTS price_catalog_entries_source_mode_check`,
    );
    await client.query(
      `ALTER TABLE price_catalog_entries
        ADD CONSTRAINT price_catalog_entries_source_mode_check
          CHECK (source_mode = 'MATERIAL')`,
    );
    await client.query(
      `UPDATE price_catalog_entries SET item_id = NULL WHERE item_id IS NULL`,
    );
    await client.query(
      `ALTER TABLE price_catalog_entries
         ALTER COLUMN uom_id SET NOT NULL,
         ALTER COLUMN item_id SET NOT NULL,
         DROP COLUMN IF EXISTS service_id`,
    );
  },
};

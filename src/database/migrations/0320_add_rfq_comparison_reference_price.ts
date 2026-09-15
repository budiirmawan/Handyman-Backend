import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-PRICE-01 PART 04 — advisory reference-price snapshots on RFQ
 * comparison lines (governance §12).
 *
 * Purely additive: every column is nullable and every CHECK tolerates the
 * all-NULL shape, so pre-existing comparison runs stay byte-compatible
 * historical evidence with `reference_resolution IS NULL` ("resolution
 * predates the price authority"). No backfill exists or will ever — metrics
 * are derived once at run creation and re-derivation is prohibited (§15).
 *
 * Governance of meaning:
 *   - The snapshot describes the single price-authority row selected by the
 *     PART 02 deterministic resolver at run-creation time (as-of the run's
 *     `snapshot_at`, per exact item / required UOM / RFQ currency, per
 *     evidence-row Vendor context).
 *   - Reference price is advisory only: these columns drive no rejection,
 *     winner, recommendation, award, PO, commitment, FX, or UOM conversion.
 *   - Variances are quotation-minus-reference, service-computed at 2dp at
 *     snapshot time (§12 PART 04 review decision); `variance_percent` is
 *     structurally NULL-safe because catalog prices are `> 0`.
 */
export const migration0320AddRfqComparisonReferencePrice: Migration = {
  id: '0320_add_rfq_comparison_reference_price',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE rfq_comparison_lines
        -- Exact price-authority row used (traceability).
        ADD COLUMN reference_price_entry_id UUID
          REFERENCES price_catalog_entries (id),
        -- Frozen price facts at comparison time.
        ADD COLUMN reference_unit_price NUMERIC(18,2),
        ADD COLUMN reference_currency VARCHAR(3),
        ADD COLUMN reference_uom_id UUID REFERENCES units_of_measure (id),
        -- Tier provenance of the selected entry (vendor/building key usage).
        ADD COLUMN reference_scope_vendor BOOLEAN,
        ADD COLUMN reference_scope_building BOOLEAN,
        -- Window provenance of the selected entry.
        ADD COLUMN reference_effective_from TIMESTAMPTZ,
        -- Explicit outcome incl. missing/incompatible and SERVICE cases.
        ADD COLUMN reference_resolution TEXT,
        -- reference_unit_price × required_quantity_snapshot when MATCHED.
        ADD COLUMN reference_total NUMERIC(18,2),
        -- Quotation minus reference (unit / extension) when MATCHED.
        ADD COLUMN unit_variance NUMERIC(18,2),
        ADD COLUMN total_variance NUMERIC(18,2),
        -- (unit_variance / reference_unit_price) × 100 when MATCHED.
        ADD COLUMN variance_percent NUMERIC,
        -- Coarse advisory indicator when MATCHED.
        ADD COLUMN position_vs_reference TEXT,

        ADD CONSTRAINT rfq_comparison_lines_reference_resolution_check
          CHECK (
            reference_resolution IS NULL
            OR reference_resolution IN (
              'MATCHED', 'NO_REFERENCE_PRICE', 'UOM_INCOMPATIBLE',
              'CURRENCY_INCOMPATIBLE', 'NOT_REQUESTED'
            )
          ),
        ADD CONSTRAINT rfq_comparison_lines_reference_position_check
          CHECK (
            position_vs_reference IS NULL
            OR position_vs_reference IN ('ABOVE', 'BELOW', 'EQUAL')
          ),
        ADD CONSTRAINT rfq_comparison_lines_reference_currency_check
          CHECK (
            reference_currency IS NULL
            OR reference_currency IN (
              'IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY'
            )
          ),

        -- Shape correlation: MATCHED requires a complete snapshot; every
        -- other outcome (and legacy NULL rows) must carry no price facts.
        ADD CONSTRAINT rfq_comparison_lines_reference_shape_check CHECK (
          (
            reference_resolution = 'MATCHED'
            AND reference_price_entry_id IS NOT NULL
            AND reference_unit_price IS NOT NULL
            AND reference_unit_price > 0
            AND reference_currency IS NOT NULL
            AND reference_uom_id IS NOT NULL
            AND reference_scope_vendor IS NOT NULL
            AND reference_scope_building IS NOT NULL
            AND reference_effective_from IS NOT NULL
            AND reference_total IS NOT NULL
            AND reference_total >= 0
            AND unit_variance IS NOT NULL
            AND total_variance IS NOT NULL
            AND variance_percent IS NOT NULL
            AND position_vs_reference IS NOT NULL
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
    await client.query(`
      ALTER TABLE rfq_comparison_lines
        DROP CONSTRAINT IF EXISTS rfq_comparison_lines_reference_resolution_check,
        DROP CONSTRAINT IF EXISTS rfq_comparison_lines_reference_position_check,
        DROP CONSTRAINT IF EXISTS rfq_comparison_lines_reference_currency_check,
        DROP CONSTRAINT IF EXISTS rfq_comparison_lines_reference_shape_check,
        DROP COLUMN IF EXISTS position_vs_reference,
        DROP COLUMN IF EXISTS variance_percent,
        DROP COLUMN IF EXISTS total_variance,
        DROP COLUMN IF EXISTS unit_variance,
        DROP COLUMN IF EXISTS reference_total,
        DROP COLUMN IF EXISTS reference_resolution,
        DROP COLUMN IF EXISTS reference_effective_from,
        DROP COLUMN IF EXISTS reference_scope_building,
        DROP COLUMN IF EXISTS reference_scope_vendor,
        DROP COLUMN IF EXISTS reference_uom_id,
        DROP COLUMN IF EXISTS reference_currency,
        DROP COLUMN IF EXISTS reference_unit_price,
        DROP COLUMN IF EXISTS reference_price_entry_id
    `);
  },
};

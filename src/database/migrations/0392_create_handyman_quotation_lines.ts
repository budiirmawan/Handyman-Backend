import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-06 PART 02 — Handyman quotation commercial snapshot lines
 * (FROZEN Decision Freeze F4/F5: LABOR/MATERIAL separation; immutable
 * snapshots; lineTotal server-calculated; one currency per version;
 * no tax/discount; CR-HM-12 pricing-rule authority preserved).
 *
 * Additive: one bounded table + immutability triggers; reverting
 * `down`; nothing else touched.
 *
 * Money/quantity conventions are the existing repository conventions
 * (NUMERIC(18,2) money, NUMERIC quantity, VARCHAR(3) currency against
 * the frozen 9-currency list, UOM via the units_of_measure master).
 * `line_total` is DB-enforced to equal ROUND(quantity *
 * final_quoted_unit_amount, 2) — the server is the only lineTotal
 * authority. `source_item_id` is provenance ONLY (it never re-prices
 * an immutable line later; inventory is never mutated here).
 */
export const migration0392CreateHandymanQuotationLines: Migration = {
  id: '0392_create_handyman_quotation_lines',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handyman_quotation_lines (
        id                       UUID PRIMARY KEY,
        quotation_version_id     UUID NOT NULL
          REFERENCES handyman_quotation_versions (id),
        line_type                TEXT NOT NULL,
        description              TEXT NOT NULL,
        quantity                 NUMERIC NOT NULL,
        uom_id                   UUID NOT NULL REFERENCES units_of_measure (id),
        reference_unit_amount    NUMERIC(18, 2),
        final_quoted_unit_amount NUMERIC(18, 2) NOT NULL,
        line_total               NUMERIC(18, 2) NOT NULL,
        currency                 VARCHAR(3) NOT NULL,
        source_item_id           UUID REFERENCES inventory_items (id),
        created_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT handyman_quotation_lines_type_check
          CHECK (line_type IN ('LABOR', 'MATERIAL')),
        CONSTRAINT handyman_quotation_lines_description_check
          CHECK (char_length(description) BETWEEN 1 AND 1000),
        CONSTRAINT handyman_quotation_lines_quantity_check
          CHECK (quantity > 0),
        CONSTRAINT handyman_quotation_lines_reference_check
          CHECK (reference_unit_amount IS NULL OR reference_unit_amount >= 0),
        CONSTRAINT handyman_quotation_lines_final_check
          CHECK (final_quoted_unit_amount >= 0),
        CONSTRAINT handyman_quotation_lines_total_check
          CHECK (line_total =
                   ROUND(quantity * final_quoted_unit_amount, 2)),
        CONSTRAINT handyman_quotation_lines_material_source_check
          CHECK (line_type = 'MATERIAL' OR source_item_id IS NULL),
        CONSTRAINT handyman_quotation_lines_currency_check
          CHECK (currency IN (
            'IDR', 'USD', 'SGD', 'MYR', 'AUD',
            'EUR', 'GBP', 'JPY', 'CNY'))
      )
    `);
    await client.query(`
      CREATE INDEX handyman_quotation_lines_version_idx
        ON handyman_quotation_lines (quotation_version_id, created_at, id)
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION handyman_quotation_line_block_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION
          'Handyman quotation lines are immutable snapshot facts.';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`
      CREATE TRIGGER handyman_quotation_line_no_write
        BEFORE UPDATE OR DELETE ON handyman_quotation_lines
        FOR EACH ROW EXECUTE FUNCTION handyman_quotation_line_block_mutation();
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query(`
      DROP TRIGGER IF EXISTS handyman_quotation_line_no_write
        ON handyman_quotation_lines;
      DROP FUNCTION IF EXISTS handyman_quotation_line_block_mutation;
      DROP TABLE IF EXISTS handyman_quotation_lines;
    `);
  },
};

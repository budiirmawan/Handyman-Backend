import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-HM-SERVICE-CATALOG-01 PART 01 — SERVICE reference-price TIER key.
 *
 * The existing price authority (`price_catalog_entries`, 0319 + the SERVICE
 * activation of 0325) allows exactly ONE ACTIVE reference price per
 * (client, service, currency, scope tier, effective window). That is the
 * right law for a plain service reference price — but it makes a
 * PARAMETERIZED price impossible: "1 PK non-inverter", "1 PK inverter" and
 * "5+ units" are three different prices for the same catalogue service, and
 * all three must be ACTIVE at the same instant.
 *
 * This migration widens the SERVICE half of the ACTIVE-window exclusion with
 * ONE governed, additive discriminator:
 *
 *   price_catalog_entries.service_price_key TEXT
 *     - MATERIAL rows: NULL (the column does not exist for MATERIAL).
 *     - SERVICE rows: NOT NULL. '' is the PLAIN service reference price — the
 *       client's baseline for the service, exactly what the price authority
 *       priced before this migration, and the only tier the plain
 *       effective-price lookup (PART 02) can ever see.
 *     - A non-empty key names a CATALOGUE PRICE TIER: the tier key is shared
 *       with the catalogue price rule that consumes the price (the rule code
 *       and the price tier key are the same governed string).
 *
 * Nothing else changes: the amount, currency, window, scope tier and
 * lifecycle stay exactly where they are; MATERIAL pricing is byte-identical;
 * the plain SERVICE lookup keeps its "at most one winner per tier" law
 * because keyed rows are excluded from it.
 */
export const migration0477ServicePriceTierKey: Migration = {
  id: '0477_service_price_tier_key',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD COLUMN service_price_key TEXT
    `);

    await client.query(`
      ALTER TABLE price_catalog_entries
        ADD CONSTRAINT price_catalog_entries_service_price_key_check
          CHECK (
            (source_mode = 'MATERIAL' AND service_price_key IS NULL)
            OR (source_mode = 'SERVICE'
                AND service_price_key IS NOT NULL
                AND length(service_price_key) <= 200)
          )
    `);

    // The SERVICE half of the ACTIVE-window exclusion is re-created with the
    // tier key as an additional discriminator. The MATERIAL half is untouched.
    await client.query(`
      ALTER TABLE price_catalog_entries
        DROP CONSTRAINT price_catalog_entries_service_window_exclusion
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
          service_price_key WITH =,
          tstzrange(effective_from, effective_to, '[)') WITH &&
        )
        WHERE (status = 'ACTIVE' AND source_mode = 'SERVICE')
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE price_catalog_entries
        DROP CONSTRAINT IF EXISTS price_catalog_entries_service_window_exclusion
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
      ALTER TABLE price_catalog_entries
        DROP CONSTRAINT IF EXISTS price_catalog_entries_service_price_key_check
    `);
    await client.query(`
      ALTER TABLE price_catalog_entries
        DROP COLUMN IF EXISTS service_price_key
    `);
  },
};

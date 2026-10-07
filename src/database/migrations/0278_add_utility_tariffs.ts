import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-UTL-01 PART 10 — governed Electricity / Water tariffs.
 *
 * A tariff is a Building-scoped specialization of the existing calculation
 * basis, not a parallel calculation engine. Existing Client-scoped bases stay
 * valid historical/reference data. New tariff rows use the same table with a
 * Building, currency and mandatory UOM, while an exclusion constraint keeps
 * ACTIVE effective windows unambiguous for each Client/Building/type scope.
 *
 * Calculations retain their existing identity and workflow. The additional
 * columns freeze the authoritative quantity and monetary tariff facts used at
 * calculation time so later tariff configuration changes cannot rewrite a
 * historical charge.
 */
export const migration0278AddUtilityTariffs: Migration = {
  id: '0278_add_utility_tariffs',

  async up(client: PoolClient): Promise<void> {
    await client.query('CREATE EXTENSION IF NOT EXISTS btree_gist');
    await client.query(`
      ALTER TABLE utility_calculation_bases
        ADD COLUMN building_id UUID REFERENCES buildings (id),
        ADD COLUMN currency VARCHAR(3),
        ADD CONSTRAINT utility_tariff_shape_check CHECK (
          (building_id IS NULL AND currency IS NULL)
          OR (
            building_id IS NOT NULL
            AND currency ~ '^[A-Z]{3}$'
            AND uom_id IS NOT NULL
            AND utility_type IN ('ELECTRICITY', 'WATER')
          )
        )
    `);
    await client.query(`
      ALTER TABLE utility_calculation_bases
        ADD CONSTRAINT utility_tariffs_active_period_exclusion
        EXCLUDE USING gist (
          client_id WITH =,
          building_id WITH =,
          utility_type WITH =,
          tstzrange(effective_from, effective_to, '[)') WITH &&
        )
        WHERE (status = 'ACTIVE' AND building_id IS NOT NULL)
    `);
    await client.query(`
      CREATE INDEX utility_tariffs_resolution_idx
        ON utility_calculation_bases
          (client_id, building_id, utility_type, uom_id, effective_from DESC)
        WHERE status = 'ACTIVE' AND building_id IS NOT NULL
    `);

    await client.query(`
      ALTER TABLE utility_calculations
        ADD COLUMN consumption_quantity NUMERIC,
        ADD COLUMN tariff_id UUID REFERENCES utility_calculation_bases (id),
        ADD COLUMN tariff_rate NUMERIC,
        ADD COLUMN currency VARCHAR(3)
    `);
    await client.query(`
      UPDATE utility_calculations calculation
         SET consumption_quantity = consumption.consumption_value
        FROM utility_meter_consumptions consumption
       WHERE consumption.id = calculation.consumption_id
    `);
    await client.query(`
      ALTER TABLE utility_calculations
        ALTER COLUMN consumption_quantity SET NOT NULL,
        ADD CONSTRAINT utility_calculation_tariff_snapshot_check CHECK (
          (tariff_id IS NULL AND tariff_rate IS NULL AND currency IS NULL)
          OR (
            tariff_id IS NOT NULL
            AND tariff_rate >= 0
            AND currency ~ '^[A-Z]{3}$'
          )
        )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      UPDATE utility_calculations
         SET calculation_basis_id = NULL
       WHERE tariff_id IS NOT NULL
    `);
    await client.query(`
      ALTER TABLE utility_calculations
        DROP CONSTRAINT IF EXISTS utility_calculation_tariff_snapshot_check,
        DROP COLUMN IF EXISTS currency,
        DROP COLUMN IF EXISTS tariff_rate,
        DROP COLUMN IF EXISTS tariff_id,
        DROP COLUMN IF EXISTS consumption_quantity
    `);
    await client.query(`
      DELETE FROM utility_calculation_bases WHERE building_id IS NOT NULL;
      DROP INDEX IF EXISTS utility_tariffs_resolution_idx;
      ALTER TABLE utility_calculation_bases
        DROP CONSTRAINT IF EXISTS utility_tariffs_active_period_exclusion,
        DROP CONSTRAINT IF EXISTS utility_tariff_shape_check,
        DROP COLUMN IF EXISTS currency,
        DROP COLUMN IF EXISTS building_id
    `);
  },
};

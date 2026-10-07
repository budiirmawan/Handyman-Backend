import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-BE-UTL-01 PART 11 — Tenant approval and immutable billing handoff. */
export const migration0279AddTenantUtilityBillingHandoff: Migration = {
  id: '0279_add_tenant_utility_billing_handoff',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE utility_meters
        ADD COLUMN purpose TEXT NOT NULL DEFAULT 'BUILDING',
        ADD CONSTRAINT utility_meters_purpose_check CHECK (
          purpose IN ('TENANT', 'BUILDING', 'COMMON_AREA', 'ENERGY_SOURCE')
        );
      UPDATE utility_meters meter SET purpose = 'TENANT'
       WHERE EXISTS (
         SELECT 1 FROM utility_meter_tenant_assignments assignment
          WHERE assignment.meter_id = meter.id
       );
      CREATE INDEX utility_meters_purpose_idx
        ON utility_meters (building_id, purpose, status);
    `);

    await client.query(`
      ALTER TABLE tenant_approval_bindings
        ADD COLUMN utility_snapshot_version SMALLINT,
        ADD COLUMN utility_space_id UUID REFERENCES spaces (id),
        ADD COLUMN utility_meter_id UUID REFERENCES utility_meters (id),
        ADD COLUMN utility_meter_purpose TEXT,
        ADD COLUMN utility_type TEXT,
        ADD COLUMN utility_period_start TIMESTAMPTZ,
        ADD COLUMN utility_period_end TIMESTAMPTZ,
        ADD COLUMN utility_consumption_quantity NUMERIC,
        ADD COLUMN utility_uom_id UUID REFERENCES units_of_measure (id),
        ADD COLUMN utility_tariff_id UUID REFERENCES utility_calculation_bases (id),
        ADD COLUMN utility_tariff_rate NUMERIC,
        ADD COLUMN utility_calculated_amount NUMERIC,
        ADD COLUMN utility_currency VARCHAR(3)
    `);

    // Existing pre-PART-11 approvals retain a NULL snapshot version. Every
    // newly inserted approval defaults to v1 and must carry a complete snapshot.
    await client.query(`
      ALTER TABLE tenant_approval_bindings
        ALTER COLUMN utility_snapshot_version SET DEFAULT 1,
        ADD CONSTRAINT tenant_approval_utility_snapshot_check CHECK (
          request_type <> 'UTILITY_CALCULATION'
          OR (utility_snapshot_version IS NULL AND utility_space_id IS NULL)
          OR (utility_snapshot_version = 1 AND (
            utility_meter_id IS NOT NULL
            AND utility_meter_purpose = 'TENANT'
            AND utility_type IN ('ELECTRICITY', 'WATER')
            AND utility_period_start IS NOT NULL
            AND utility_period_end > utility_period_start
            AND utility_consumption_quantity >= 0
            AND utility_uom_id IS NOT NULL
            AND utility_tariff_id IS NOT NULL
            AND utility_tariff_rate >= 0
            AND utility_calculated_amount >= 0
            AND utility_currency ~ '^[A-Z]{3}$'
          ))
        ) NOT VALID;
    `);

    await client.query(`
      ALTER TABLE utility_bills
        ADD COLUMN approval_id UUID UNIQUE REFERENCES tenant_approval_bindings (id),
        ADD COLUMN space_id UUID REFERENCES spaces (id),
        ADD COLUMN consumption_quantity NUMERIC,
        ADD COLUMN uom_id UUID REFERENCES units_of_measure (id),
        ADD COLUMN tariff_rate NUMERIC,
        ADD COLUMN currency VARCHAR(3),
        ADD CONSTRAINT utility_bill_handoff_snapshot_check CHECK (
          approval_id IS NULL
          OR (
            space_id IS NOT NULL
            AND consumption_quantity >= 0
            AND uom_id IS NOT NULL
            AND tariff_rate >= 0
            AND currency ~ '^[A-Z]{3}$'
          )
        )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE utility_bills
        DROP CONSTRAINT IF EXISTS utility_bill_handoff_snapshot_check,
        DROP COLUMN IF EXISTS currency,
        DROP COLUMN IF EXISTS tariff_rate,
        DROP COLUMN IF EXISTS uom_id,
        DROP COLUMN IF EXISTS consumption_quantity,
        DROP COLUMN IF EXISTS space_id,
        DROP COLUMN IF EXISTS approval_id
    `);
    await client.query(`
      ALTER TABLE tenant_approval_bindings
        DROP CONSTRAINT IF EXISTS tenant_approval_utility_snapshot_check,
        DROP COLUMN IF EXISTS utility_currency,
        DROP COLUMN IF EXISTS utility_calculated_amount,
        DROP COLUMN IF EXISTS utility_tariff_rate,
        DROP COLUMN IF EXISTS utility_tariff_id,
        DROP COLUMN IF EXISTS utility_uom_id,
        DROP COLUMN IF EXISTS utility_consumption_quantity,
        DROP COLUMN IF EXISTS utility_period_end,
        DROP COLUMN IF EXISTS utility_period_start,
        DROP COLUMN IF EXISTS utility_type,
        DROP COLUMN IF EXISTS utility_meter_purpose,
        DROP COLUMN IF EXISTS utility_meter_id,
        DROP COLUMN IF EXISTS utility_space_id,
        DROP COLUMN IF EXISTS utility_snapshot_version
    `);
    await client.query(`
      DROP INDEX IF EXISTS utility_meters_purpose_idx;
      ALTER TABLE utility_meters
        DROP CONSTRAINT IF EXISTS utility_meters_purpose_check,
        DROP COLUMN IF EXISTS purpose
    `);
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-18G — Consumption.
 *
 * A consumption row is the *derived delta* between two authoritative BE-18E
 * Meter Readings on the same Meter:
 *
 *   consumption = current reading value - previous reading value
 *
 * Reading data is never duplicated here. The row stores only foreign keys to
 * the two readings (`previous_reading_id`, `current_reading_id`) plus the
 * derived result; the values themselves stay in `utility_meter_readings`,
 * which remains the single source of truth. `period_start` / `period_end`
 * mirror the readings' instants so a period can be queried without joining,
 * and are constrained to be strictly ordered — a reversed or zero-length
 * period is a data error, not a zero-consumption fact.
 *
 * `consumption_value` is CHECKed `>= 0`. A meter that appears to run backwards
 * means a rollover, a replacement, or a misread; those need an explicit
 * decision, so BE-18G refuses to persist a negative delta silently. The
 * service surfaces that as a validation error rather than storing it.
 *
 * The UOM is copied from the readings only after both have been verified to
 * agree with each other and with the BE-18A meter configuration — it is a
 * denormalised label of the already-validated unit, not a second authority.
 *
 * Tenant context (BE-18D) is snapshotted the same way BE-18E snapshots it:
 * `tenant_assignment_id` / `tenant_company_id` record who the meter served
 * across this period. After tenancy turnover it cannot be re-derived, and a
 * historical consumption must not be silently re-attributed.
 *
 * Calculation history is preserved: rows are append-only. A unique index on
 * (meter_id, current_reading_id) makes recalculating the same pair idempotent
 * rather than silently producing divergent duplicates, and there is no update
 * or delete path in the module.
 *
 * Out of scope, deliberately: tariffs, rates, cost, invoicing, allocation and
 * any Utility Calculation (later waves). Billing never lives in BE-18.
 */
export const migration0190CreateUtilityMeterConsumptions: Migration = {
  id: '0190_create_utility_meter_consumptions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_meter_consumptions (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL REFERENCES clients (id),
        building_id          UUID NOT NULL REFERENCES buildings (id),
        meter_id             UUID NOT NULL REFERENCES utility_meters (id),
        previous_reading_id  UUID NOT NULL
          REFERENCES utility_meter_readings (id),
        current_reading_id   UUID NOT NULL
          REFERENCES utility_meter_readings (id),
        uom_id               UUID NOT NULL REFERENCES units_of_measure (id),
        consumption_value    NUMERIC NOT NULL,
        period_start         TIMESTAMPTZ NOT NULL,
        period_end           TIMESTAMPTZ NOT NULL,
        calculated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        calculated_by_user_id UUID REFERENCES users (id),
        tenant_assignment_id UUID
          REFERENCES utility_meter_tenant_assignments (id),
        tenant_company_id    UUID REFERENCES tenant_companies (id),
        notes                TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_meter_consumptions_period_check
          CHECK (period_end > period_start),
        CONSTRAINT utility_meter_consumptions_value_check
          CHECK (consumption_value >= 0),
        CONSTRAINT utility_meter_consumptions_readings_check
          CHECK (previous_reading_id <> current_reading_id)
      )
    `);

    // Recalculating the same closing reading is idempotent, never duplicated.
    await client.query(`
      CREATE UNIQUE INDEX utility_meter_consumptions_current_reading_unique
        ON utility_meter_consumptions (meter_id, current_reading_id)
    `);

    await client.query(`
      CREATE INDEX utility_meter_consumptions_meter_period_idx
        ON utility_meter_consumptions (meter_id, period_end DESC);
      CREATE INDEX utility_meter_consumptions_building_idx
        ON utility_meter_consumptions (building_id, period_end DESC);
      CREATE INDEX utility_meter_consumptions_client_idx
        ON utility_meter_consumptions (client_id, period_end DESC);
      CREATE INDEX utility_meter_consumptions_tenant_idx
        ON utility_meter_consumptions (tenant_company_id, period_end DESC);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS utility_meter_consumptions');
  },
};

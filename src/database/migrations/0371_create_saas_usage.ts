import type { Migration } from './types';

/**
 * CR-BE-SAAS-01 PART 09 — Usage & Metering (frozen §12.3).
 *
 * Three canonical tables, all additive:
 *
 *  - `saas_usage_meters` (platform-global meter definitions):
 *      id, meter_key UNIQUE, name, unit, period_types JSONB
 *      (subset of DAILY/MONTHLY/BILLING_PERIOD), status, version, timestamps.
 *  - `saas_usage_records` (append-only event log):
 *      id, customer_id, building_id NULLABLE, meter_key, quantity
 *      (NUMERIC(18,4) >= 0), scope (CURRENT/DAILY/MONTHLY/BILLING_PERIOD),
 *      period_start, period_end, source (BACKEND/TRUSTED_INTEGRATION),
 *      source_reference (dedup key), recorded_by_user_id NULLABLE,
 *      created_at.
 *      UNIQUE (customer_id, meter_key, scope, period_start,
 *              source_reference) — double-recording is structurally
 *      impossible (frozen §12.3).
 *  - `saas_usage_aggregations`:
 *      id, customer_id, meter_key, scope, period_start, period_end,
 *      total_quantity NUMERIC(28,4), record_count, updated_at, version.
 *      UNIQUE (customer_id, meter_key, scope, period_start, period_end).
 *      Maintained transactionally with records (§12.3 last bullet).
 *
 * FKs:
 *  - customer_id → clients(id)
 *  - building_id → properties(id) (Facility Operations canonical
 *    building store; nullable for customer-scoped meters)
 *  - meter_key → saas_usage_meters.meter_key
 *
 * No PART 09 business code lives in this migration — table shape only.
 */
export const migration0371CreateSaasUsage: Migration = {
  id: '0371_create_saas_usage',
  async up(client) {
    await client.query(`
      CREATE TABLE saas_usage_meters (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        meter_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        unit TEXT NOT NULL,
        period_types JSONB NOT NULL DEFAULT '[]'::jsonb,
        status TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE saas_usage_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL REFERENCES clients(id),
        building_id UUID REFERENCES properties(id),
        meter_key TEXT NOT NULL REFERENCES saas_usage_meters(meter_key),
        quantity NUMERIC(18,4) NOT NULL CHECK (quantity >= 0),
        scope TEXT NOT NULL
          CHECK (scope IN ('CURRENT', 'DAILY', 'MONTHLY', 'BILLING_PERIOD')),
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL CHECK (period_end > period_start),
        source TEXT NOT NULL
          CHECK (source IN ('BACKEND', 'TRUSTED_INTEGRATION')),
        source_reference TEXT NOT NULL,
        recorded_by_user_id UUID REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_usage_records_dedup
          UNIQUE (customer_id, meter_key, scope, period_start, source_reference)
      )
    `);
    await client.query(
      `CREATE INDEX saas_usage_records_customer_meter_scope_period_idx
         ON saas_usage_records (customer_id, meter_key, scope, period_start)`,
    );
    await client.query(
      `CREATE INDEX saas_usage_records_building_idx
         ON saas_usage_records (building_id)`,
    );

    await client.query(`
      CREATE TABLE saas_usage_aggregations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        customer_id UUID NOT NULL REFERENCES clients(id),
        meter_key TEXT NOT NULL REFERENCES saas_usage_meters(meter_key),
        scope TEXT NOT NULL
          CHECK (scope IN ('CURRENT', 'DAILY', 'MONTHLY', 'BILLING_PERIOD')),
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL CHECK (period_end > period_start),
        total_quantity NUMERIC(28,4) NOT NULL DEFAULT 0 CHECK (total_quantity >= 0),
        record_count INTEGER NOT NULL DEFAULT 0 CHECK (record_count >= 0),
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT saas_usage_aggregations_window_unique
          UNIQUE (customer_id, meter_key, scope, period_start, period_end)
      )
    `);
    await client.query(
      `CREATE INDEX saas_usage_aggregations_customer_idx
         ON saas_usage_aggregations (customer_id, meter_key)`,
    );
  },
  async down(client) {
    await client.query(`DROP TABLE IF EXISTS saas_usage_aggregations`);
    await client.query(`DROP TABLE IF EXISTS saas_usage_records`);
    await client.query(`DROP TABLE IF EXISTS saas_usage_meters`);
  },
};

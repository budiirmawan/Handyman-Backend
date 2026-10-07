import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-ESG-01 PART 03 — ESG Metric Values & Periods.
 *
 * Building-scoped periodized ESG values, defined by
 * `docs/CR-BE-ESG-01_START_GOVERNANCE.md` §4.6 / §5 / §7:
 *
 * - Client ownership derived via Building → Property → Client (same as
 *   PART 02), never from caller.
 * - Governed `metric_definition_id` FK composite (id, client_id) — same Client,
 *   ACTIVE for new values (service-layer).
 * - `period_type` CHECK DAILY/MONTHLY/QUARTERLY/YEARLY.
 * - `period_start` / `period_end` TIMESTAMPTZ, CHECK end > start.
 * - `value` NUMERIC — NULLABLE only when `data_quality = MISSING` to avoid
 *   fabricating a value for unavailable data (governance §7 / PART 03 rule).
 * - Governed `uom_id` FK, same Client enforced in service layer.
 * - `calculation_method` CHECK CALCULATED/MANUAL/HYBRID.
 * - `source_type` CHECK UTILITY_CONSUMPTION/WASTE_RECORD/MANUAL_ENTRY/IMPORT/SYSTEM.
 * - `source_refs` JSONB provenance only (array of UUIDs), never invented.
 * - `data_quality` CHECK ACTUAL/ESTIMATED/MISSING.
 * - `verification_status` CHECK PENDING/VERIFIED/REJECTED/NOT_REQUIRED.
 * - Unique metric/building/period authority:
 *   UNIQUE (client_id, building_id, metric_definition_id, period_start, period_end)
 *   — no silent overwrite of an existing period.
 *
 * No automatic utility/waste aggregation (PART 05), no baseline/target,
 * no verification workflow, no evidence bindings, no KPI/reporting,
 * no recycling-rate, no IKE/IKA recalculation, no emission factors,
 * no scheduler, no backfill.
 */
export const migration0328CreateEsgMetricValues: Migration = {
  id: '0328_create_esg_metric_values',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE esg_metric_values (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        metric_definition_id  UUID NOT NULL,
        period_type           TEXT NOT NULL,
        period_start          TIMESTAMPTZ NOT NULL,
        period_end            TIMESTAMPTZ NOT NULL,
        value                 NUMERIC,
        uom_id                UUID NOT NULL REFERENCES units_of_measure (id),
        calculation_method    TEXT NOT NULL,
        source_type           TEXT NOT NULL,
        source_refs           JSONB,
        data_quality          TEXT NOT NULL DEFAULT 'ACTUAL',
        verification_status   TEXT NOT NULL DEFAULT 'PENDING',
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT esg_metric_values_metric_scope_fk
          FOREIGN KEY (metric_definition_id, client_id)
          REFERENCES esg_metric_definitions (id, client_id),

        CONSTRAINT esg_metric_values_period_check
          CHECK (period_end > period_start),

        CONSTRAINT esg_metric_values_period_type_check
          CHECK (period_type IN ('DAILY','MONTHLY','QUARTERLY','YEARLY')),

        CONSTRAINT esg_metric_values_calc_method_check
          CHECK (calculation_method IN ('CALCULATED','MANUAL','HYBRID')),

        CONSTRAINT esg_metric_values_source_type_check
          CHECK (source_type IN ('UTILITY_CONSUMPTION','WASTE_RECORD','MANUAL_ENTRY','IMPORT','SYSTEM')),

        CONSTRAINT esg_metric_values_data_quality_check
          CHECK (data_quality IN ('ACTUAL','ESTIMATED','MISSING')),

        CONSTRAINT esg_metric_values_verification_check
          CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','NOT_REQUIRED')),

        CONSTRAINT esg_metric_values_value_quality_check
          CHECK (
            (data_quality = 'MISSING' AND (value IS NULL OR value IS NOT NULL))
            OR (data_quality != 'MISSING' AND value IS NOT NULL)
          ),

        CONSTRAINT esg_metric_values_unique_period
          UNIQUE (client_id, building_id, metric_definition_id, period_start, period_end)
      )
    `);

    await client.query(`
      CREATE INDEX esg_metric_values_client_idx
        ON esg_metric_values (client_id);
      CREATE INDEX esg_metric_values_building_idx
        ON esg_metric_values (building_id, period_start DESC);
      CREATE INDEX esg_metric_values_metric_idx
        ON esg_metric_values (metric_definition_id, period_start DESC);
      CREATE INDEX esg_metric_values_period_idx
        ON esg_metric_values (building_id, metric_definition_id, period_type, period_start DESC);
      CREATE INDEX esg_metric_values_uom_idx
        ON esg_metric_values (uom_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS esg_metric_values');
  },
};

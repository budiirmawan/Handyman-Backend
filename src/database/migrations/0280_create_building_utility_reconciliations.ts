import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-UTL-01 PART 12 — Building reconciliation and IKE/IKA snapshots.
 *
 * Existing Spaces receive only an optional physical-area measurement. The
 * hierarchy remains authoritative and is not duplicated. Reconciliation rows
 * are immutable analytical snapshots over existing ACTUAL-reading-derived
 * consumptions and never participate in Tenant approval or billing.
 */
export const migration0280CreateBuildingUtilityReconciliations: Migration = {
  id: '0280_create_building_utility_reconciliations',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE spaces
        ADD COLUMN area_sqm NUMERIC,
        ADD CONSTRAINT spaces_area_sqm_check
          CHECK (area_sqm IS NULL OR area_sqm > 0)
    `);

    await client.query(`
      CREATE TABLE building_utility_reconciliations (
        id                         UUID PRIMARY KEY,
        client_id                  UUID NOT NULL REFERENCES clients (id),
        building_id                UUID NOT NULL REFERENCES buildings (id),
        utility_type               TEXT NOT NULL,
        period_start               TIMESTAMPTZ NOT NULL,
        period_end                 TIMESTAMPTZ NOT NULL,
        uom_id                     UUID NOT NULL REFERENCES units_of_measure (id),
        source_consumption_ids     UUID[] NOT NULL,
        tenant_consumption_ids     UUID[] NOT NULL,
        common_area_consumption_ids UUID[] NOT NULL,
        source_consumption         NUMERIC NOT NULL,
        tenant_consumption         NUMERIC NOT NULL,
        common_area_consumption    NUMERIC NOT NULL,
        unallocated_consumption    NUMERIC NOT NULL,
        reconciliation_percentage NUMERIC,
        applicable_area_sqm        NUMERIC NOT NULL,
        performance_metric         TEXT NOT NULL,
        performance_value          NUMERIC NOT NULL,
        calculated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        calculated_by_user_id      UUID NOT NULL REFERENCES users (id),
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT building_utility_reconciliation_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER')),
        CONSTRAINT building_utility_reconciliation_period_check
          CHECK (period_end > period_start),
        CONSTRAINT building_utility_reconciliation_values_check CHECK (
          source_consumption >= 0
          AND tenant_consumption >= 0
          AND common_area_consumption >= 0
          AND applicable_area_sqm > 0
          AND performance_value >= 0
        ),
        CONSTRAINT building_utility_reconciliation_percentage_check
          CHECK (reconciliation_percentage IS NULL OR reconciliation_percentage >= 0),
        CONSTRAINT building_utility_reconciliation_metric_check CHECK (
          (utility_type = 'ELECTRICITY' AND performance_metric = 'IKE')
          OR (utility_type = 'WATER' AND performance_metric = 'IKA')
        ),
        CONSTRAINT building_utility_reconciliation_scope_unique
          UNIQUE (client_id, building_id, utility_type, period_start, period_end)
      )
    `);
    await client.query(`
      CREATE INDEX building_utility_reconciliation_building_idx
        ON building_utility_reconciliations
          (building_id, utility_type, period_end DESC);
      CREATE INDEX building_utility_reconciliation_client_idx
        ON building_utility_reconciliations
          (client_id, building_id, period_end DESC)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS building_utility_reconciliations');
    await client.query(`
      ALTER TABLE spaces
        DROP CONSTRAINT IF EXISTS spaces_area_sqm_check,
        DROP COLUMN IF EXISTS area_sqm
    `);
  },
};

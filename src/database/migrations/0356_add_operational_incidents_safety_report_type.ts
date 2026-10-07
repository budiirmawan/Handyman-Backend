import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-RN18-SAFETY-FIELD-REPORT-01 — Hazard / Near-Miss Field Reporting.
 *
 * Adds nullable column `safety_report_type` to `operational_incidents`:
 *   HAZARD | NEAR_MISS
 *
 * DB CHECK:
 *   safety_report_type IS NULL OR safety_report_type IN ('HAZARD', 'NEAR_MISS')
 *
 * Existing generic operationalCategory='SAFETY' incidents remain valid with NULL.
 * No backfill.
 */
export const migration0356AddOperationalIncidentsSafetyReportType: Migration = {
  id: '0356_add_operational_incidents_safety_report_type',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE operational_incidents
        ADD COLUMN safety_report_type TEXT,
        ADD CONSTRAINT operational_incidents_safety_report_type_check
          CHECK (safety_report_type IS NULL OR safety_report_type IN ('HAZARD', 'NEAR_MISS'))
    `);

    await client.query(`
      CREATE INDEX operational_incidents_safety_report_type_idx
        ON operational_incidents (safety_report_type)
        WHERE safety_report_type IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`DROP INDEX IF EXISTS operational_incidents_safety_report_type_idx`);
    await client.query(`
      ALTER TABLE operational_incidents
        DROP CONSTRAINT IF EXISTS operational_incidents_safety_report_type_check,
        DROP COLUMN IF EXISTS safety_report_type
    `);
  },
};

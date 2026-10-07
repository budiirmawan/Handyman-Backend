import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-11K — Quality Audit.
 *
 * Provides a quality review and scoring layer across Housekeeping operational
 * executions (Daily Cleaning, Toilet Inspection, Public Area Inspection,
 * Supervisor Inspection, or Cleaning Areas).
 */
export const migration0118CreateQualityAudits: Migration = {
  id: '0118_create_quality_audits',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE quality_audits (
        id               UUID PRIMARY KEY,
        client_id        UUID NOT NULL REFERENCES clients (id),
        building_id      UUID NOT NULL REFERENCES buildings (id),
        cleaning_area_id UUID REFERENCES cleaning_areas (id),
        source_type      TEXT NOT NULL,
        source_id        UUID NOT NULL,
        auditor_user_id  UUID NOT NULL REFERENCES users (id),
        score            NUMERIC,
        result           TEXT,
        status           TEXT NOT NULL DEFAULT 'DRAFT',
        notes            TEXT,
        audited_at       TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT quality_audits_source_type
          CHECK (source_type IN (
            'DAILY_CLEANING', 'TOILET_INSPECTION',
            'PUBLIC_AREA_INSPECTION', 'SUPERVISOR_INSPECTION', 'CLEANING_AREA'
          )),
        CONSTRAINT quality_audits_result
          CHECK (result IS NULL OR result IN ('PASS', 'FAIL', 'REWORK_REQUIRED')),
        CONSTRAINT quality_audits_status
          CHECK (status IN ('DRAFT', 'COMPLETED')),
        CONSTRAINT quality_audits_score
          CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
        CONSTRAINT quality_audits_completed
          CHECK (
            (status = 'COMPLETED' AND result IS NOT NULL AND audited_at IS NOT NULL)
            OR status = 'DRAFT'
          )
      )
    `);

    await client.query(`
      CREATE INDEX quality_audits_building_idx
        ON quality_audits (building_id, status);
      CREATE INDEX quality_audits_area_idx
        ON quality_audits (cleaning_area_id, status);
      CREATE INDEX quality_audits_source_idx
        ON quality_audits (source_type, source_id);
      CREATE INDEX quality_audits_auditor_idx
        ON quality_audits (auditor_user_id);
      CREATE INDEX quality_audits_result_idx
        ON quality_audits (result);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS quality_audits');
  },
};

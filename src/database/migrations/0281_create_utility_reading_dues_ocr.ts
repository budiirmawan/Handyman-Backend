import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** CR-BE-UTL-01 PART 14 — Reading Due and optional PHOTO OCR assistance. */
export const migration0281CreateUtilityReadingDuesOcr: Migration = {
  id: '0281_create_utility_reading_dues_ocr',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE schedule_definitions DROP CONSTRAINT schedule_target;
      ALTER TABLE schedule_definitions ADD CONSTRAINT schedule_target CHECK (
        target_type IN (
          'FORM_TEMPLATE', 'FORM_VERSION', 'CHECKLIST_TEMPLATE', 'UTILITY_METER'
        )
      )
    `);
    // CR-BE-EVD-01's latest constraint accidentally narrowed the shared
    // execution union. OCR depends on the already-published Utility PHOTO
    // evidence path, so restore every existing parent kind without adding a
    // new evidence engine.
    await client.query(`
      ALTER TABLE evidence_submissions DROP CONSTRAINT evidence_submission_execution;
      ALTER TABLE evidence_submissions ADD CONSTRAINT evidence_submission_execution CHECK (
        execution_type IN (
          'FORM_INSTANCE', 'CHECKLIST_EXECUTION', 'WORK_ORDER', 'VENDOR_WORK',
          'UTILITY_METER_READING', 'PERMIT', 'FINDING', 'FINDING_REWORK',
          'FINDING_VERIFICATION'
        )
      )
    `);
    await client.query(`
      CREATE TABLE utility_reading_dues (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        meter_id               UUID NOT NULL REFERENCES utility_meters (id),
        utility_type           TEXT NOT NULL,
        period_start           TIMESTAMPTZ NOT NULL,
        period_end             TIMESTAMPTZ NOT NULL,
        due_at                 TIMESTAMPTZ NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'DUE',
        schedule_definition_id UUID REFERENCES schedule_definitions (id),
        generated_task_id      UUID REFERENCES generated_tasks (id),
        meter_reading_id       UUID UNIQUE REFERENCES utility_meter_readings (id),
        completed_at           TIMESTAMPTZ,
        completed_by_user_id   UUID REFERENCES users (id),
        cancelled_at           TIMESTAMPTZ,
        cancelled_by_user_id   UUID REFERENCES users (id),
        cancellation_reason    TEXT,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_reading_due_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
        CONSTRAINT utility_reading_due_period_check CHECK (period_end > period_start),
        CONSTRAINT utility_reading_due_status_check
          CHECK (status IN ('DUE', 'COMPLETED', 'CANCELLED')),
        CONSTRAINT utility_reading_due_state_check CHECK (
          (status = 'DUE' AND meter_reading_id IS NULL AND completed_at IS NULL
            AND cancelled_at IS NULL)
          OR (status = 'COMPLETED' AND meter_reading_id IS NOT NULL
            AND completed_at IS NOT NULL AND completed_by_user_id IS NOT NULL
            AND cancelled_at IS NULL)
          OR (status = 'CANCELLED' AND meter_reading_id IS NULL
            AND completed_at IS NULL AND cancelled_at IS NOT NULL
            AND cancelled_by_user_id IS NOT NULL AND cancellation_reason IS NOT NULL)
        ),
        CONSTRAINT utility_reading_due_meter_period_unique
          UNIQUE (meter_id, period_start, period_end),
        CONSTRAINT utility_reading_due_task_unique UNIQUE (generated_task_id)
      )
    `);
    await client.query(`
      CREATE INDEX utility_reading_due_building_idx
        ON utility_reading_dues (building_id, due_at, status);
      CREATE INDEX utility_reading_due_client_idx
        ON utility_reading_dues (client_id, building_id, due_at);
      CREATE INDEX utility_reading_due_meter_idx
        ON utility_reading_dues (meter_id, period_end DESC)
    `);

    await client.query(`
      CREATE TABLE utility_meter_ocr_candidates (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        meter_id              UUID NOT NULL REFERENCES utility_meters (id),
        evidence_id           UUID NOT NULL UNIQUE REFERENCES evidence_submissions (id),
        candidate_reading_value NUMERIC NOT NULL,
        confidence            NUMERIC,
        status                TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
        accepted_reading_id   UUID REFERENCES utility_meter_readings (id),
        verified_by_user_id   UUID REFERENCES users (id),
        verified_at           TIMESTAMPTZ,
        decision_notes        TEXT,
        created_by_user_id    UUID NOT NULL REFERENCES users (id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_meter_ocr_value_check
          CHECK (candidate_reading_value >= 0),
        CONSTRAINT utility_meter_ocr_confidence_check
          CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
        CONSTRAINT utility_meter_ocr_status_check
          CHECK (status IN ('PENDING_REVIEW', 'ACCEPTED', 'REJECTED')),
        CONSTRAINT utility_meter_ocr_decision_check CHECK (
          (status = 'PENDING_REVIEW' AND verified_by_user_id IS NULL
            AND verified_at IS NULL AND accepted_reading_id IS NULL)
          OR (status = 'ACCEPTED' AND verified_by_user_id IS NOT NULL
            AND verified_at IS NOT NULL AND accepted_reading_id IS NOT NULL)
          OR (status = 'REJECTED' AND verified_by_user_id IS NOT NULL
            AND verified_at IS NOT NULL AND accepted_reading_id IS NULL
            AND decision_notes IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE INDEX utility_meter_ocr_building_idx
        ON utility_meter_ocr_candidates (building_id, status, created_at);
      CREATE INDEX utility_meter_ocr_meter_idx
        ON utility_meter_ocr_candidates (meter_id, created_at DESC)
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS utility_meter_ocr_candidates');
    await client.query(`
      ALTER TABLE evidence_submissions DROP CONSTRAINT evidence_submission_execution;
      ALTER TABLE evidence_submissions ADD CONSTRAINT evidence_submission_execution CHECK (
        execution_type IN (
          'FORM_INSTANCE', 'CHECKLIST_EXECUTION',
          'FINDING', 'FINDING_REWORK', 'FINDING_VERIFICATION'
        )
      )
    `);
    await client.query('DROP TABLE IF EXISTS utility_reading_dues');
    await client.query(`
      DELETE FROM generated_tasks WHERE schedule_definition_id IN (
        SELECT id FROM schedule_definitions WHERE target_type = 'UTILITY_METER'
      );
      DELETE FROM schedule_definitions WHERE target_type = 'UTILITY_METER';
      ALTER TABLE schedule_definitions DROP CONSTRAINT schedule_target;
      ALTER TABLE schedule_definitions ADD CONSTRAINT schedule_target CHECK (
        target_type IN ('FORM_TEMPLATE', 'FORM_VERSION', 'CHECKLIST_TEMPLATE')
      )
    `);
  },
};

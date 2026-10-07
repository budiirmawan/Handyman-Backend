import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * CR-BE-UTL-01 PART 15 — cross-Utility operational exception register.
 *
 * This table references existing Utility facts. It does not copy Meter,
 * Reading, OCR, Consumption, abnormality, or reconciliation values and does
 * not replace BE-09 Findings or the BE-07 review primitive.
 */
export const migration0282CreateUtilityOperationalExceptions: Migration = {
  id: '0282_create_utility_operational_exceptions',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE utility_operational_exceptions (
        id                      UUID PRIMARY KEY,
        client_id               UUID NOT NULL REFERENCES clients (id),
        building_id             UUID NOT NULL REFERENCES buildings (id),
        utility_type            TEXT NOT NULL,
        meter_id                UUID REFERENCES utility_meters (id),
        meter_reading_id        UUID REFERENCES utility_meter_readings (id),
        reading_due_id          UUID REFERENCES utility_reading_dues (id),
        consumption_id          UUID REFERENCES utility_meter_consumptions (id),
        abnormal_consumption_id UUID REFERENCES utility_abnormal_consumptions (id),
        ocr_candidate_id        UUID REFERENCES utility_meter_ocr_candidates (id),
        reconciliation_id       UUID REFERENCES building_utility_reconciliations (id),
        exception_type          TEXT NOT NULL,
        severity                TEXT NOT NULL,
        status                  TEXT NOT NULL DEFAULT 'OPEN',
        summary                 TEXT NOT NULL,
        details                 TEXT,
        detected_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        detected_by_user_id     UUID NOT NULL REFERENCES users (id),
        reviewer_user_id        UUID REFERENCES users (id),
        review_notes            TEXT,
        review_started_at       TIMESTAMPTZ,
        resolved_by_user_id     UUID REFERENCES users (id),
        resolved_at             TIMESTAMPTZ,
        resolution_notes        TEXT,
        cancelled_by_user_id    UUID REFERENCES users (id),
        cancelled_at            TIMESTAMPTZ,
        cancellation_reason     TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT utility_exception_utility_type_check
          CHECK (utility_type IN ('ELECTRICITY', 'WATER', 'GAS')),
        CONSTRAINT utility_exception_type_check CHECK (exception_type IN (
          'ABNORMAL_CONSUMPTION', 'MISSING_OR_LATE_READING',
          'OCR_MANUAL_FOLLOW_UP', 'RECONCILIATION_VARIANCE',
          'UNALLOCATED_CONSUMPTION', 'OTHER'
        )),
        CONSTRAINT utility_exception_severity_check
          CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
        CONSTRAINT utility_exception_status_check
          CHECK (status IN ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CANCELLED')),
        CONSTRAINT utility_exception_reference_check CHECK (
          meter_id IS NOT NULL OR meter_reading_id IS NOT NULL
          OR reading_due_id IS NOT NULL OR consumption_id IS NOT NULL
          OR abnormal_consumption_id IS NOT NULL OR ocr_candidate_id IS NOT NULL
          OR reconciliation_id IS NOT NULL
        ),
        CONSTRAINT utility_exception_lifecycle_check CHECK (
          (status = 'OPEN' AND reviewer_user_id IS NULL
            AND review_started_at IS NULL AND resolved_at IS NULL
            AND cancelled_at IS NULL)
          OR (status = 'UNDER_REVIEW' AND reviewer_user_id IS NOT NULL
            AND review_started_at IS NOT NULL AND resolved_at IS NULL
            AND cancelled_at IS NULL)
          OR (status = 'RESOLVED' AND reviewer_user_id IS NOT NULL
            AND review_started_at IS NOT NULL AND resolved_by_user_id IS NOT NULL
            AND resolved_at IS NOT NULL AND resolution_notes IS NOT NULL
            AND cancelled_at IS NULL)
          OR (status = 'CANCELLED' AND resolved_at IS NULL
            AND cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL
            AND cancellation_reason IS NOT NULL)
        )
      )
    `);
    // COALESCE selects the most specific source in deterministic priority
    // order. One active review per source/type prevents duplicate queues while
    // resolved/cancelled history remains append-only.
    await client.query(`
      CREATE UNIQUE INDEX utility_exception_active_source_unique
        ON utility_operational_exceptions (
          exception_type,
          COALESCE(reconciliation_id, abnormal_consumption_id, ocr_candidate_id,
            consumption_id, reading_due_id, meter_reading_id, meter_id)
        )
        WHERE status IN ('OPEN', 'UNDER_REVIEW')
    `);
    await client.query(`
      CREATE INDEX utility_exception_building_idx
        ON utility_operational_exceptions (building_id, status, detected_at DESC);
      CREATE INDEX utility_exception_client_idx
        ON utility_operational_exceptions (client_id, building_id, detected_at DESC);
      CREATE INDEX utility_exception_reconciliation_idx
        ON utility_operational_exceptions (reconciliation_id, status)
        WHERE reconciliation_id IS NOT NULL;
      CREATE INDEX utility_exception_reviewer_idx
        ON utility_operational_exceptions (reviewer_user_id, status)
        WHERE reviewer_user_id IS NOT NULL
    `);
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS utility_operational_exceptions');
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-11G — Supervisor Inspection.
 *
 * Links an inspected Housekeeping execution (Daily Cleaning, Toilet Inspection,
 * or Public Area Inspection) to a supervisor review/decision, reusing the BE-07
 * Review / Verification engine without duplicating logic.
 */
export const migration0115CreateSupervisorInspections: Migration = {
  id: '0115_create_supervisor_inspections',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE supervisor_inspections (
        id                 UUID PRIMARY KEY,
        client_id          UUID NOT NULL REFERENCES clients (id),
        building_id        UUID NOT NULL REFERENCES buildings (id),
        cleaning_area_id   UUID NOT NULL REFERENCES cleaning_areas (id),
        target_type        TEXT NOT NULL,
        target_id          UUID NOT NULL,
        review_id          UUID REFERENCES reviews (id),
        supervisor_user_id UUID NOT NULL REFERENCES users (id),
        decision           TEXT,
        status             TEXT NOT NULL DEFAULT 'PENDING',
        notes              TEXT,
        inspected_at       TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT supervisor_inspection_target_type
          CHECK (target_type IN (
            'DAILY_CLEANING', 'TOILET_INSPECTION', 'PUBLIC_AREA_INSPECTION'
          )),
        CONSTRAINT supervisor_inspection_decision
          CHECK (decision IS NULL OR decision IN (
            'APPROVED', 'REJECTED', 'REWORK_REQUIRED'
          )),
        CONSTRAINT supervisor_inspection_status
          CHECK (status IN ('PENDING', 'COMPLETED')),
        CONSTRAINT supervisor_inspection_completed
          CHECK (
            (status = 'COMPLETED' AND decision IS NOT NULL AND inspected_at IS NOT NULL)
            OR status = 'PENDING'
          )
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX supervisor_inspections_target_pending_unique
        ON supervisor_inspections (target_type, target_id)
        WHERE status = 'PENDING';
      CREATE INDEX supervisor_inspections_building_idx
        ON supervisor_inspections (building_id, status);
      CREATE INDEX supervisor_inspections_area_idx
        ON supervisor_inspections (cleaning_area_id, status);
      CREATE INDEX supervisor_inspections_target_idx
        ON supervisor_inspections (target_type, target_id);
      CREATE INDEX supervisor_inspections_supervisor_idx
        ON supervisor_inspections (supervisor_user_id, status);
      CREATE INDEX supervisor_inspections_review_idx
        ON supervisor_inspections (review_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS supervisor_inspections');
  },
};

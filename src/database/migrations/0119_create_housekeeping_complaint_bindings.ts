import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-11L — Housekeeping Complaint Binding.
 *
 * Minimal Housekeeping operational binding associating customer/tenant complaints
 * or service requests to Housekeeping operations (Daily Cleaning, Toilet Inspection,
 * Public Area Inspection, Supervisor Inspection, Cleaning Areas, or Findings).
 */
export const migration0119CreateHousekeepingComplaintBindings: Migration = {
  id: '0119_create_housekeeping_complaint_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE housekeeping_complaint_bindings (
        id                       UUID PRIMARY KEY,
        client_id                UUID NOT NULL REFERENCES clients (id),
        building_id              UUID NOT NULL REFERENCES buildings (id),
        complaint_reference      TEXT NOT NULL,
        work_request_id          UUID REFERENCES work_requests (id),
        cleaning_area_id         UUID REFERENCES cleaning_areas (id),
        housekeeping_source_type TEXT,
        housekeeping_source_id   UUID,
        finding_id               UUID REFERENCES findings (id),
        description              TEXT,
        status                   TEXT NOT NULL DEFAULT 'ACTIVE',
        created_by_user_id       UUID NOT NULL REFERENCES users (id),
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT housekeeping_complaint_binding_status
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT housekeeping_complaint_source_type
          CHECK (
            housekeeping_source_type IS NULL
            OR housekeeping_source_type IN (
              'DAILY_CLEANING', 'TOILET_INSPECTION',
              'PUBLIC_AREA_INSPECTION', 'SUPERVISOR_INSPECTION', 'CLEANING_AREA'
            )
          ),
        CONSTRAINT housekeeping_complaint_source_pair
          CHECK ((housekeeping_source_type IS NULL) = (housekeeping_source_id IS NULL))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX housekeeping_complaint_binding_active_unique
        ON housekeeping_complaint_bindings (
          complaint_reference, housekeeping_source_type, housekeeping_source_id
        )
        WHERE status = 'ACTIVE' AND housekeeping_source_id IS NOT NULL;
      CREATE INDEX housekeeping_complaint_building_idx
        ON housekeeping_complaint_bindings (building_id, status);
      CREATE INDEX housekeeping_complaint_area_idx
        ON housekeeping_complaint_bindings (cleaning_area_id, status);
      CREATE INDEX housekeeping_complaint_reference_idx
        ON housekeeping_complaint_bindings (complaint_reference);
      CREATE INDEX housekeeping_complaint_finding_idx
        ON housekeeping_complaint_bindings (finding_id);
      CREATE INDEX housekeeping_complaint_work_request_idx
        ON housekeeping_complaint_bindings (work_request_id);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS housekeeping_complaint_bindings');
  },
};

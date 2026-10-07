import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15F — Vendor Completion Report.
 *
 * A reporting layer only — NOT a separate completion workflow engine. Each row
 * records the vendor's completion report for a BE-15B Vendor Work: the
 * completion summary/notes, the completing actor, the completion timestamp,
 * the completion status, and the BE-07 evidence-readiness result.
 *
 *   Vendor Work → Vendor Completion Report → Work Order
 *
 * `client_id`, `building_id`, and `work_order_id` are stored directly but
 * derived authoritatively by the service from the Vendor Work → Work Order, so
 * isolation can never drift from BE-08 / BE-02.
 *
 * One report per Vendor Work is enforced by the UNIQUE constraint on
 * `vendor_work_id` (so duplicate/final completion cannot fan out). The
 * lifecycle is DRAFT → SUBMITTED (final): a SUBMITTED report is immutable and
 * `completed_at` / `completed_by_user_id` are set exactly at submission.
 * Required BE-07 evidence must be satisfied before submission (enforced by the
 * service) and the result is snapshotted in `evidence_ready` /
 * `missing_evidence_types`.
 */
export const migration0160CreateVendorCompletionReports: Migration = {
  id: '0160_create_vendor_completion_reports',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_completion_reports (
        id                     UUID PRIMARY KEY,
        client_id              UUID NOT NULL REFERENCES clients (id),
        vendor_work_id         UUID NOT NULL REFERENCES vendor_works (id),
        work_order_id          UUID NOT NULL REFERENCES work_orders (id),
        building_id            UUID NOT NULL REFERENCES buildings (id),
        completion_status      TEXT NOT NULL DEFAULT 'DRAFT',
        summary                TEXT,
        notes                  TEXT,
        completed_by_user_id   UUID REFERENCES users (id),
        completed_at           TIMESTAMPTZ,
        evidence_ready         BOOLEAN NOT NULL DEFAULT FALSE,
        missing_evidence_types JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by_user_id     UUID NOT NULL REFERENCES users (id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_completion_reports_work_unique
          UNIQUE (vendor_work_id),
        CONSTRAINT vendor_completion_reports_status_check
          CHECK (completion_status IN ('DRAFT', 'SUBMITTED'))
      )
    `);

    await client.query(`
      CREATE INDEX vendor_completion_reports_building_idx
        ON vendor_completion_reports (building_id, completion_status);
      CREATE INDEX vendor_completion_reports_work_order_idx
        ON vendor_completion_reports (work_order_id, completion_status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_completion_reports');
  },
};

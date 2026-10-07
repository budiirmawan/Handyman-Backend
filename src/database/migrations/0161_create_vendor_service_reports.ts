import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15G — Vendor Service Report.
 *
 * A reporting layer only — NOT a separate service workflow engine. Each row
 * records the vendor's service report for a BE-15B Vendor Work: the service
 * report number, service date, service summary, work performed,
 * recommendation / follow-up notes, the preparing actor, and a DRAFT →
 * FINALIZED lifecycle.
 *
 *   Vendor Work → Vendor Service Report → Work Order / Completion Report
 *
 * `client_id`, `building_id`, and `work_order_id` are stored directly but
 * derived authoritatively by the service from the Vendor Work → Work Order;
 * `completion_report_id` links the BE-15F completion report for the same
 * Vendor Work when one exists. One report per Vendor Work is enforced by the
 * UNIQUE constraint on `vendor_work_id`; `service_report_number` is stable and
 * unique per Client (following the BE-08 work-order-number idiom).
 *
 * A FINALIZED report is immutable; report history is preserved through the
 * shared BE-07 operational-events timeline.
 */
export const migration0161CreateVendorServiceReports: Migration = {
  id: '0161_create_vendor_service_reports',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_service_reports (
        id                    UUID PRIMARY KEY,
        client_id             UUID NOT NULL REFERENCES clients (id),
        vendor_work_id        UUID NOT NULL REFERENCES vendor_works (id),
        completion_report_id  UUID REFERENCES vendor_completion_reports (id),
        work_order_id         UUID NOT NULL REFERENCES work_orders (id),
        building_id           UUID NOT NULL REFERENCES buildings (id),
        service_report_number TEXT NOT NULL,
        service_date          DATE NOT NULL,
        summary               TEXT,
        work_performed        TEXT,
        recommendation        TEXT,
        prepared_by_user_id   UUID NOT NULL REFERENCES users (id),
        status                TEXT NOT NULL DEFAULT 'DRAFT',
        finalized_at          TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_service_reports_work_unique
          UNIQUE (vendor_work_id),
        CONSTRAINT vendor_service_reports_number_unique
          UNIQUE (client_id, service_report_number),
        CONSTRAINT vendor_service_reports_status_check
          CHECK (status IN ('DRAFT', 'FINALIZED'))
      )
    `);

    await client.query(`
      CREATE INDEX vendor_service_reports_building_idx
        ON vendor_service_reports (building_id, status);
      CREATE INDEX vendor_service_reports_work_order_idx
        ON vendor_service_reports (work_order_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_service_reports');
  },
};

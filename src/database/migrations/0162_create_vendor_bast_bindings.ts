import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-15H — BAST Binding.
 *
 * A binding/document layer only — NOT a separate BAST workflow engine. Each
 * row records the Berita Acara Serah Terima (handover acceptance) for a
 * BE-15B Vendor Work: the BAST reference/number, BAST date, preparing /
 * submitting / accepting actors, acceptance status, notes, and an opaque
 * file/document reference (never a binary).
 *
 *   Vendor Work → BAST → Work Order / Completion Report / Service Report
 *
 * `client_id`, `building_id`, and `work_order_id` are stored directly but
 * derived authoritatively by the service from the Vendor Work → Work Order;
 * `completion_report_id` / `service_report_id` link the BE-15F / BE-15G
 * reports for the same Vendor Work when they exist. One BAST per Vendor Work
 * is enforced by the UNIQUE constraint on `vendor_work_id`; `bast_number` is
 * stable and unique per Client.
 *
 * Acceptance lifecycle (backend-authoritative):
 *
 *   DRAFT → SUBMITTED → ACCEPTED
 *                    ↘ REJECTED
 *
 * `submitted_by_user_id` / `submitted_at` are set at submission;
 * `accepted_by_user_id` / `accepted_at` at acceptance or rejection. ACCEPTED
 * and REJECTED are terminal. History is preserved through the shared BE-07
 * operational-events timeline.
 */
export const migration0162CreateVendorBastBindings: Migration = {
  id: '0162_create_vendor_bast_bindings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE vendor_bast_bindings (
        id                   UUID PRIMARY KEY,
        client_id            UUID NOT NULL REFERENCES clients (id),
        vendor_work_id       UUID NOT NULL REFERENCES vendor_works (id),
        completion_report_id UUID REFERENCES vendor_completion_reports (id),
        service_report_id    UUID REFERENCES vendor_service_reports (id),
        work_order_id        UUID NOT NULL REFERENCES work_orders (id),
        building_id          UUID NOT NULL REFERENCES buildings (id),
        bast_number          TEXT NOT NULL,
        bast_date            DATE NOT NULL,
        prepared_by_user_id  UUID NOT NULL REFERENCES users (id),
        submitted_by_user_id UUID REFERENCES users (id),
        accepted_by_user_id  UUID REFERENCES users (id),
        acceptance_status    TEXT NOT NULL DEFAULT 'DRAFT',
        notes                TEXT,
        file_reference       TEXT,
        submitted_at         TIMESTAMPTZ,
        accepted_at          TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT vendor_bast_bindings_work_unique
          UNIQUE (vendor_work_id),
        CONSTRAINT vendor_bast_bindings_number_unique
          UNIQUE (client_id, bast_number),
        CONSTRAINT vendor_bast_bindings_status_check
          CHECK (acceptance_status IN
            ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED'))
      )
    `);

    await client.query(`
      CREATE INDEX vendor_bast_bindings_building_idx
        ON vendor_bast_bindings (building_id, acceptance_status);
      CREATE INDEX vendor_bast_bindings_work_order_idx
        ON vendor_bast_bindings (work_order_id, acceptance_status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS vendor_bast_bindings');
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-22C — BAST (Berita Acara Serah Terima) via shared Document foundation.
 *
 * ONE authoritative BAST Document foundation for INTERNAL / TENANT / VENDOR.
 * Reuses Work Order (BE-08) / Vendor Work (BE-15B) / Work Completion (BE-22B)
 * — no duplication, no second BAST engine.
 * BE-15H vendor_bast_bindings must point to this authoritative BAST.
 */
export const migration0226CreateBastDocuments: Migration = {
  id: '0226_create_bast_documents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE bast_documents (
        id                          UUID PRIMARY KEY,
        document_id                 UUID NOT NULL UNIQUE REFERENCES documents (id) ON DELETE CASCADE,
        work_order_id               UUID NOT NULL REFERENCES work_orders (id),
        vendor_work_id              UUID REFERENCES vendor_works (id),
        work_completion_document_id UUID REFERENCES work_completion_documents (id),
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        context_type                TEXT NOT NULL,
        bast_number                 TEXT NOT NULL,
        bast_date                   DATE NOT NULL,
        acceptance_status           TEXT NOT NULL DEFAULT 'DRAFT',
        notes                       TEXT,
        file_reference              TEXT,
        prepared_by_user_id         UUID NOT NULL REFERENCES users (id),
        submitted_by_user_id        UUID REFERENCES users (id),
        accepted_by_user_id         UUID REFERENCES users (id),
        submitted_at                TIMESTAMPTZ,
        accepted_at                 TIMESTAMPTZ,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT bast_documents_context_check
          CHECK (context_type IN ('INTERNAL', 'TENANT', 'VENDOR')),
        CONSTRAINT bast_documents_status_check
          CHECK (acceptance_status IN ('DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED')),
        CONSTRAINT bast_documents_client_number_unique
          UNIQUE (client_id, bast_number)
      )
    `);

    await client.query(`
      CREATE INDEX bast_documents_work_order_idx
        ON bast_documents (work_order_id, acceptance_status);
      CREATE INDEX bast_documents_vendor_work_idx
        ON bast_documents (vendor_work_id, acceptance_status);
      CREATE INDEX bast_documents_work_completion_idx
        ON bast_documents (work_completion_document_id);
      CREATE INDEX bast_documents_building_idx
        ON bast_documents (building_id, acceptance_status);
      CREATE INDEX bast_documents_client_idx
        ON bast_documents (client_id, acceptance_status);
      CREATE INDEX bast_documents_context_idx
        ON bast_documents (context_type, acceptance_status);
      CREATE INDEX bast_documents_document_idx
        ON bast_documents (document_id);
    `);

    // Partial unique: one BAST per vendor_work when vendor_work is present
    await client.query(`
      CREATE UNIQUE INDEX bast_documents_vendor_work_unique
        ON bast_documents (vendor_work_id)
        WHERE vendor_work_id IS NOT NULL
    `);

    // BE-15H compatibility: vendor_bast_bindings must point to authoritative BAST
    await client.query(`
      ALTER TABLE vendor_bast_bindings
        ADD COLUMN bast_document_id UUID REFERENCES bast_documents (id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX vendor_bast_bindings_bast_document_idx
        ON vendor_bast_bindings (bast_document_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('ALTER TABLE vendor_bast_bindings DROP COLUMN IF EXISTS bast_document_id');
    await client.query('DROP TABLE IF EXISTS bast_documents');
  },
};

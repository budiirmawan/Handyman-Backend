import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-22D — Handover Document.
 *
 * Binds shared Document foundation to valid work / completion / BAST context.
 * Reuses Work Order / Vendor Work / Work Completion (BE-22B) / BAST (BE-22C)
 * — no separate handover engine, no duplication.
 * Supports INTERNAL / TENANT / VENDOR.
 */
export const migration0227CreateHandoverDocuments: Migration = {
  id: '0227_create_handover_documents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE handover_documents (
        id                          UUID PRIMARY KEY,
        document_id                 UUID NOT NULL UNIQUE REFERENCES documents (id) ON DELETE CASCADE,
        work_order_id               UUID NOT NULL REFERENCES work_orders (id),
        vendor_work_id              UUID REFERENCES vendor_works (id),
        work_completion_document_id UUID REFERENCES work_completion_documents (id),
        bast_document_id            UUID REFERENCES bast_documents (id),
        client_id                   UUID NOT NULL REFERENCES clients (id),
        building_id                 UUID NOT NULL REFERENCES buildings (id),
        context_type                TEXT NOT NULL,
        handover_number             TEXT NOT NULL,
        handover_date               DATE NOT NULL,
        handover_status             TEXT NOT NULL DEFAULT 'DRAFT',
        notes                       TEXT,
        file_reference              TEXT,
        prepared_by_user_id         UUID NOT NULL REFERENCES users (id),
        handed_over_by_user_id      UUID REFERENCES users (id),
        handed_over_at              TIMESTAMPTZ,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT handover_documents_context_check
          CHECK (context_type IN ('INTERNAL', 'TENANT', 'VENDOR')),
        CONSTRAINT handover_documents_status_check
          CHECK (handover_status IN ('DRAFT', 'HANDED_OVER')),
        CONSTRAINT handover_documents_client_number_unique
          UNIQUE (client_id, handover_number)
      )
    `);

    await client.query(`
      CREATE INDEX handover_documents_work_order_idx
        ON handover_documents (work_order_id, handover_status);
      CREATE INDEX handover_documents_vendor_work_idx
        ON handover_documents (vendor_work_id, handover_status);
      CREATE INDEX handover_documents_work_completion_idx
        ON handover_documents (work_completion_document_id);
      CREATE INDEX handover_documents_bast_idx
        ON handover_documents (bast_document_id);
      CREATE INDEX handover_documents_building_idx
        ON handover_documents (building_id, handover_status);
      CREATE INDEX handover_documents_client_idx
        ON handover_documents (client_id, handover_status);
      CREATE INDEX handover_documents_context_idx
        ON handover_documents (context_type, handover_status);
      CREATE INDEX handover_documents_document_idx
        ON handover_documents (document_id);
    `);

    // Unique per vendor work when present (one handover per vendor work)
    await client.query(`
      CREATE UNIQUE INDEX handover_documents_vendor_work_unique
        ON handover_documents (vendor_work_id)
        WHERE vendor_work_id IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS handover_documents');
  },
};

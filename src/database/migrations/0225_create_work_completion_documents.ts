import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-22B — Work Completion Document.
 *
 * Binds ONE shared Document foundation (BE-22A) to a valid completed work context.
 * Reuses Work Order (BE-08) and Vendor Work (BE-15B) masters — no duplication.
 * Supports INTERNAL / TENANT / VENDOR via the shared document's context_type.
 * History via operational_events, no hard delete.
 */
export const migration0225CreateWorkCompletionDocuments: Migration = {
  id: '0225_create_work_completion_documents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE work_completion_documents (
        id                  UUID PRIMARY KEY,
        document_id         UUID NOT NULL UNIQUE REFERENCES documents (id) ON DELETE CASCADE,
        work_order_id       UUID NOT NULL REFERENCES work_orders (id),
        vendor_work_id      UUID REFERENCES vendor_works (id),
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID NOT NULL REFERENCES buildings (id),
        context_type        TEXT NOT NULL,
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT work_completion_context_check
          CHECK (context_type IN ('INTERNAL', 'TENANT', 'VENDOR')),
        CONSTRAINT work_completion_vendor_check
          CHECK (
            (vendor_work_id IS NULL)
            OR
            (vendor_work_id IS NOT NULL AND work_order_id IS NOT NULL)
          )
      )
    `);

    await client.query(`
      CREATE INDEX work_completion_documents_work_order_idx
        ON work_completion_documents (work_order_id);
      CREATE INDEX work_completion_documents_vendor_work_idx
        ON work_completion_documents (vendor_work_id);
      CREATE INDEX work_completion_documents_client_idx
        ON work_completion_documents (client_id);
      CREATE INDEX work_completion_documents_building_idx
        ON work_completion_documents (building_id, context_type);
      CREATE INDEX work_completion_documents_context_idx
        ON work_completion_documents (context_type);
      CREATE INDEX work_completion_documents_document_idx
        ON work_completion_documents (document_id);
    `);

    // Example: seed could ensure permissions exist, but document permissions already cover this.
    // No separate permission needed — reuses document.read/manage.
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS work_completion_documents');
  },
};

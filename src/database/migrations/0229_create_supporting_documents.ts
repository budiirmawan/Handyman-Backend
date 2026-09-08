import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-22F — Supporting Document.
 *
 * Uses shared Document foundation (BE-22A), may support Work Completion,
 * BAST, Handover, Sign-Off, Tenant or Vendor context. No separate engine,
 * no large binaries in PG (file_reference only), preserves history.
 */
export const migration0229CreateSupportingDocuments: Migration = {
  id: '0229_create_supporting_documents',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE supporting_documents (
        id                  UUID PRIMARY KEY,
        document_id         UUID NOT NULL UNIQUE REFERENCES documents (id) ON DELETE CASCADE,
        parent_type         TEXT NOT NULL,
        parent_id           UUID NOT NULL,
        client_id           UUID NOT NULL REFERENCES clients (id),
        building_id         UUID REFERENCES buildings (id),
        context_type        TEXT NOT NULL,
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT supporting_documents_parent_check
          CHECK (parent_type IN ('WORK_COMPLETION','BAST','HANDOVER','SIGN_OFF','TENANT_COMPANY','VENDOR','DOCUMENT')),
        CONSTRAINT supporting_documents_context_check
          CHECK (context_type IN ('INTERNAL', 'TENANT', 'VENDOR'))
      )
    `);

    await client.query(`
      CREATE INDEX supporting_documents_parent_idx
        ON supporting_documents (parent_type, parent_id);
      CREATE INDEX supporting_documents_document_idx
        ON supporting_documents (document_id);
      CREATE INDEX supporting_documents_client_idx
        ON supporting_documents (client_id);
      CREATE INDEX supporting_documents_building_idx
        ON supporting_documents (building_id, context_type);
      CREATE INDEX supporting_documents_context_idx
        ON supporting_documents (context_type);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS supporting_documents');
  },
};

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-22J — reversible Document archive without deleting document history. */
export const migration0233AddDocumentArchive: Migration = {
  id: '0233_add_document_archive',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE documents DROP CONSTRAINT documents_status_check;
      ALTER TABLE documents
        ADD CONSTRAINT documents_status_check
          CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED')),
        ADD COLUMN archived_at TIMESTAMPTZ,
        ADD COLUMN archived_by_user_id UUID REFERENCES users (id),
        ADD COLUMN archive_reason TEXT,
        ADD COLUMN status_before_archive TEXT,
        ADD CONSTRAINT documents_archive_state_check CHECK (
          (status = 'ARCHIVED'
            AND archived_at IS NOT NULL
            AND archived_by_user_id IS NOT NULL
            AND status_before_archive IN ('DRAFT', 'ACTIVE', 'INACTIVE'))
          OR
          (status <> 'ARCHIVED'
            AND archived_at IS NULL
            AND archived_by_user_id IS NULL
            AND archive_reason IS NULL
            AND status_before_archive IS NULL)
        );
      CREATE INDEX documents_archived_at_idx
        ON documents (client_id, archived_at) WHERE status = 'ARCHIVED';
    `);

    await client.query(
      `INSERT INTO permissions (id, code, name, status)
       VALUES ($1, 'document.archive', 'Archive and Restore Documents', 'ACTIVE')
       ON CONFLICT (code) DO NOTHING`,
      [randomUUID()],
    );
    await client.query(
      `INSERT INTO role_permission_assignments (id, role_id, permission_id, status)
       SELECT $1, r.id, p.id, 'ACTIVE'
       FROM roles r CROSS JOIN permissions p
       WHERE r.code = 'PLATFORM_ADMIN' AND p.code = 'document.archive'
       ON CONFLICT (role_id, permission_id) WHERE status = 'ACTIVE' DO NOTHING`,
      [randomUUID()],
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      UPDATE documents
      SET status = COALESCE(status_before_archive, 'INACTIVE')
      WHERE status = 'ARCHIVED';
      DROP INDEX IF EXISTS documents_archived_at_idx;
      ALTER TABLE documents DROP CONSTRAINT documents_archive_state_check;
      ALTER TABLE documents DROP CONSTRAINT documents_status_check;
      ALTER TABLE documents
        DROP COLUMN archived_at,
        DROP COLUMN archived_by_user_id,
        DROP COLUMN archive_reason,
        DROP COLUMN status_before_archive;
      ALTER TABLE documents
        ADD CONSTRAINT documents_status_check
          CHECK (status IN ('DRAFT', 'ACTIVE', 'INACTIVE'));
    `);
  },
};

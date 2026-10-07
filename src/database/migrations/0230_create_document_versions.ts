import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-22G — Document Version.
 * Versions belong to an existing Document, preserve complete history,
 * previous versions must not be overwritten, track current/latest.
 */
export const migration0230CreateDocumentVersions: Migration = {
  id: '0230_create_document_versions',

  async up(client: PoolClient): Promise<void> {
    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    await client.query(`
      CREATE TABLE document_versions (
        id                  UUID PRIMARY KEY,
        document_id         UUID NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
        version_number      INT NOT NULL,
        title               TEXT NOT NULL,
        description         TEXT,
        file_reference      TEXT,
        document_type       TEXT NOT NULL,
        status              TEXT NOT NULL,
        created_by_user_id  UUID NOT NULL REFERENCES users (id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT document_versions_document_version_unique
          UNIQUE (document_id, version_number),
        CONSTRAINT document_versions_version_check
          CHECK (version_number >= 1)
      )
    `);

    await client.query(`
      CREATE INDEX document_versions_document_idx
        ON document_versions (document_id, version_number);
      CREATE INDEX document_versions_document_latest_idx
        ON document_versions (document_id, version_number DESC);
    `);

    // Seed initial version 1 for existing documents (preserve history baseline)
    await client.query(`
      INSERT INTO document_versions
        (id, document_id, version_number, title, description, file_reference, document_type, status, created_by_user_id)
      SELECT
        gen_random_uuid(),
        d.id,
        1,
        d.title,
        d.description,
        d.file_reference,
        d.document_type,
        d.status,
        d.created_by_user_id
      FROM documents d
      ON CONFLICT (document_id, version_number) DO NOTHING
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS document_versions');
  },
};

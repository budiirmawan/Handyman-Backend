import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-22H — Expiry.
 * Expiry belongs to valid Document/version, tracks expiry date and derived state.
 * No scheduler/job engine, preserve history via versions.
 */
export const migration0231AddDocumentExpiry: Migration = {
  id: '0231_add_document_expiry',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE documents
        ADD COLUMN expiry_date TIMESTAMPTZ
    `);

    await client.query(`
      ALTER TABLE document_versions
        ADD COLUMN expiry_date TIMESTAMPTZ
    `);

    await client.query(`
      CREATE INDEX documents_expiry_date_idx
        ON documents (expiry_date)
        WHERE expiry_date IS NOT NULL
    `);

    await client.query(`
      CREATE INDEX document_versions_expiry_date_idx
        ON document_versions (expiry_date)
        WHERE expiry_date IS NOT NULL
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP INDEX IF EXISTS document_versions_expiry_date_idx');
    await client.query('DROP INDEX IF EXISTS documents_expiry_date_idx');
    await client.query('ALTER TABLE document_versions DROP COLUMN IF EXISTS expiry_date');
    await client.query('ALTER TABLE documents DROP COLUMN IF EXISTS expiry_date');
  },
};

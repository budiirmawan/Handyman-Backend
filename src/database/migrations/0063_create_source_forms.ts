import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-07A — client-scoped register of approved operational source forms. */
export const migration0063CreateSourceForms: Migration = {
  id: '0063_create_source_forms',
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE source_forms (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_reference TEXT,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT source_forms_client_code_unique UNIQUE (client_id, code),
        CONSTRAINT source_forms_source_type_check
          CHECK (source_type IN ('INTERNAL', 'VENDOR', 'EXTERNAL_REFERENCE')),
        CONSTRAINT source_forms_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query('CREATE INDEX source_forms_client_id_idx ON source_forms (client_id)');
    await client.query('CREATE INDEX source_forms_client_status_idx ON source_forms (client_id, status)');
  },
  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS source_forms');
  },
};

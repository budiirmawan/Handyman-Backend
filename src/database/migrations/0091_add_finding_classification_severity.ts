import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-09B — Client-scoped Finding classification and severity reference data. */
export const migration0091AddFindingClassificationSeverity: Migration = {
  id: '0091_add_finding_classification_severity',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE finding_classifications (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT finding_classification_status
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT finding_classification_client_code_unique
          UNIQUE (client_id, code)
      );

      CREATE TABLE finding_severities (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        rank INTEGER NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT finding_severity_rank CHECK (rank > 0),
        CONSTRAINT finding_severity_status
          CHECK (status IN ('ACTIVE', 'INACTIVE')),
        CONSTRAINT finding_severity_client_code_unique
          UNIQUE (client_id, code)
      );

      ALTER TABLE findings
        ADD COLUMN classification_id UUID REFERENCES finding_classifications (id),
        ADD COLUMN severity_id UUID REFERENCES finding_severities (id);

      CREATE INDEX finding_classifications_client_idx
        ON finding_classifications (client_id, status, code);
      CREATE INDEX finding_severities_client_idx
        ON finding_severities (client_id, status, rank, code);
      CREATE INDEX findings_classification_idx
        ON findings (classification_id, status);
      CREATE INDEX findings_severity_idx
        ON findings (severity_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE findings
        DROP COLUMN IF EXISTS severity_id,
        DROP COLUMN IF EXISTS classification_id;
      DROP TABLE IF EXISTS finding_severities;
      DROP TABLE IF EXISTS finding_classifications;
    `);
  },
};

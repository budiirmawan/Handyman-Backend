import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-09A — generic Finding foundation.
 *
 * Findings are intentionally limited to identity, core metadata, and the
 * minimal OPEN/CANCELLED intake lifecycle. Classification, source binding,
 * assignment, verification, closure, and workflow history are added only by
 * later BE-09 parts.
 */
export const migration0090CreateFindings: Migration = {
  id: '0090_create_findings',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE findings (
        id UUID PRIMARY KEY,
        client_id UUID NOT NULL REFERENCES clients (id),
        building_id UUID NOT NULL REFERENCES buildings (id),
        finding_number TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'OPEN',
        reported_by_user_id UUID NOT NULL REFERENCES users (id),
        reported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT finding_status CHECK (status IN ('OPEN', 'CANCELLED')),
        CONSTRAINT finding_number_unique UNIQUE (client_id, finding_number)
      )
    `);

    await client.query(`
      CREATE INDEX findings_client_idx
        ON findings (client_id, status, reported_at);
      CREATE INDEX findings_building_idx
        ON findings (building_id, status, reported_at);
      CREATE INDEX findings_reporter_idx
        ON findings (reported_by_user_id, reported_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS findings');
  },
};

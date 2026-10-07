import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-03A — Organization foundation.
 *
 * An Organization is a top-level workforce / business-structure unit scoped to
 * a single Client. It is NOT a Property, Building, Subscription, Role, or
 * Permission — those domains remain in BE-01/BE-02.
 *
 * Organization provides the parent container for Department (BE-03A).
 *
 * `code` is unique per Client (enforced by a partial unique index on
 * (client_id, code) WHERE status = 'ACTIVE'). Inactive organizations keep
 * their codes reserved for history.
 */
export const migration0020CreateOrganizations: Migration = {
  id: '0020_create_organizations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE organizations (
        id           UUID PRIMARY KEY,
        client_id    UUID NOT NULL,
        code         TEXT NOT NULL,
        name         TEXT NOT NULL,
        description  TEXT,
        status       TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT organizations_client_id_fkey
          FOREIGN KEY (client_id) REFERENCES clients (id),
        CONSTRAINT organizations_code_unique
          UNIQUE (client_id, code),
        CONSTRAINT organizations_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX organizations_client_id_idx
        ON organizations (client_id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS organizations');
  },
};

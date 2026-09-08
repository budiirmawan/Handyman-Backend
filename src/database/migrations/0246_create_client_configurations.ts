import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-27A — Client Configuration foundation.
 *
 * Stores authoritative key/value configuration scoped to one existing Client.
 * This is intentionally a small, unversioned foundation:
 *
 * - `client_id` is the only scope; Building overrides arrive in BE-27B.
 * - `key` is a stable, normalized configuration key unique per Client.
 * - `value` is JSONB so values can be scalar or structured without storing
 *   executable behavior.
 * - `status` controls present effectiveness (ACTIVE / INACTIVE). It is record
 *   availability, not the BE-27N/O version/publish lifecycle.
 *
 * No version, validation, preview, publish, ACTIVE-version, supersession,
 * workspace, navigation, CMS, or branding tables are introduced here.
 */
export const migration0246CreateClientConfigurations: Migration = {
  id: '0246_create_client_configurations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE client_configurations (
        id         UUID PRIMARY KEY,
        client_id  UUID NOT NULL REFERENCES clients (id),
        key        TEXT NOT NULL,
        value      JSONB NOT NULL,
        status     TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT client_configurations_client_key_unique
          UNIQUE (client_id, key),
        CONSTRAINT client_configurations_key_check
          CHECK (
            char_length(key) BETWEEN 1 AND 100
            AND key ~ '^[A-Z][A-Z0-9_.-]*$'
          ),
        CONSTRAINT client_configurations_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX client_configurations_client_status_key_idx
        ON client_configurations (client_id, status, key)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS client_configurations');
  },
};

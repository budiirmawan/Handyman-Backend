import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-27B — Building Configuration foundation.
 *
 * Stores authoritative key/value overrides for one existing Building. Client
 * ownership is intentionally not duplicated: it is always derived through
 * Building → Property → Client, preserving the existing hierarchy authority.
 *
 * ACTIVE / INACTIVE controls present record effectiveness only. Versioning,
 * validation, preview and publish lifecycle remain deferred to BE-27N/O/P.
 */
export const migration0247CreateBuildingConfigurations: Migration = {
  id: '0247_create_building_configurations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE building_configurations (
        id          UUID PRIMARY KEY,
        building_id UUID NOT NULL REFERENCES buildings (id),
        key         TEXT NOT NULL,
        value       JSONB NOT NULL,
        status      TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT building_configurations_building_key_unique
          UNIQUE (building_id, key),
        CONSTRAINT building_configurations_key_check
          CHECK (
            char_length(key) BETWEEN 1 AND 100
            AND key ~ '^[A-Z][A-Z0-9_.-]*$'
          ),
        CONSTRAINT building_configurations_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE INDEX building_configurations_building_status_key_idx
        ON building_configurations (building_id, status, key)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS building_configurations');
  },
};

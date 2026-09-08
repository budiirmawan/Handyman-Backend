import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01E — Permission foundation.
 *
 * A Permission is an explicit backend capability identified by a stable,
 * normalized `resource.action` code (e.g. `user.read`). Capability, context,
 * and entitlement stay separate; no wildcard semantics are encoded here.
 */
export const migration0007CreatePermissions: Migration = {
  id: '0007_create_permissions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE permissions (
        id UUID PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT permissions_code_unique UNIQUE (code),
        CONSTRAINT permissions_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS permissions');
  },
};

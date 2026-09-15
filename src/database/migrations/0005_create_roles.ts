import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01D — Role foundation.
 *
 * Roles are configurable access groupings, not authorization on their own.
 * `code` is the stable, machine-readable identifier (normalized to uppercase
 * by the service layer) and must be unique.
 */
export const migration0005CreateRoles: Migration = {
  id: '0005_create_roles',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE roles (
        id UUID PRIMARY KEY,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT roles_code_unique UNIQUE (code),
        CONSTRAINT roles_status_check CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS roles');
  },
};

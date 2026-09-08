import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01A — User identity foundation.
 * Creates the platform identity table. Credentials live in a separate
 * table (BE-01B); no password/security fields are stored here.
 */
export const migration0002CreateUsers: Migration = {
  id: '0002_create_users',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT users_email_unique UNIQUE (email),
        CONSTRAINT users_status_check CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED'))
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS users');
  },
};

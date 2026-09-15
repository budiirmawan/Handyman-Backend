import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01B — Credential & password foundation.
 *
 * Keeps identity (users) and credentials separated. Stores only a
 * non-reversible password hash; never plaintext. The UNIQUE (user_id)
 * constraint enforces at most one credential per user (the service layer
 * creates exactly one for onboarding).
 */
export const migration0003CreateUserCredentials: Migration = {
  id: '0003_create_user_credentials',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE user_credentials (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        password_hash TEXT NOT NULL,
        must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
        password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT user_credentials_user_id_unique UNIQUE (user_id),
        CONSTRAINT user_credentials_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS user_credentials');
  },
};

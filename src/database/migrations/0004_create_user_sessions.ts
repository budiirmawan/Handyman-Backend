import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01C — Login / session foundation.
 *
 * Stores only the hash of an opaque random session token; the raw token is
 * returned to the client once and never persisted. Session lifecycle is
 * minimal: ACTIVE or REVOKED, with expiry derived from expires_at.
 */
export const migration0004CreateUserSessions: Migration = {
  id: '0004_create_user_sessions',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE user_sessions (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        CONSTRAINT user_sessions_token_hash_unique UNIQUE (token_hash),
        CONSTRAINT user_sessions_status_check CHECK (status IN ('ACTIVE', 'REVOKED')),
        CONSTRAINT user_sessions_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    await client.query(
      'CREATE INDEX user_sessions_user_id_idx ON user_sessions (user_id)',
    );
    await client.query(
      'CREATE INDEX user_sessions_expires_at_idx ON user_sessions (expires_at)',
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS user_sessions');
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01G — Invitation foundation.
 *
 * Stores only the hash of an opaque random invitation token; the raw token is
 * returned once at creation and never persisted. Lifecycle is minimal:
 * PENDING, ACCEPTED, or REVOKED, with expiry derived from expires_at.
 */
export const migration0010CreateUserInvitations: Migration = {
  id: '0010_create_user_invitations',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE user_invitations (
        id UUID PRIMARY KEY,
        email TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        expires_at TIMESTAMPTZ NOT NULL,
        invited_by_user_id UUID,
        accepted_by_user_id UUID,
        accepted_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT user_invitations_token_hash_unique UNIQUE (token_hash),
        CONSTRAINT user_invitations_status_check
          CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED')),
        CONSTRAINT user_invitations_invited_by_fkey
          FOREIGN KEY (invited_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
        CONSTRAINT user_invitations_accepted_by_fkey
          FOREIGN KEY (accepted_by_user_id) REFERENCES users (id) ON DELETE SET NULL
      )
    `);

    await client.query(
      'CREATE INDEX user_invitations_email_idx ON user_invitations (email)',
    );
    await client.query(
      'CREATE INDEX user_invitations_expires_at_idx ON user_invitations (expires_at)',
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS user_invitations');
  },
};

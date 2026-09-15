import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01G — Account lifecycle.
 *
 * Adds the INVITED account status (onboarding not completed) to the users
 * status constraint without rebuilding the table. Authentication continues to
 * allow only ACTIVE users (enforced in BE-01C).
 */
export const migration0009AddInvitedUserStatus: Migration = {
  id: '0009_add_invited_user_status',

  async up(client: PoolClient): Promise<void> {
    await client.query('ALTER TABLE users DROP CONSTRAINT users_status_check');
    await client.query(`
      ALTER TABLE users ADD CONSTRAINT users_status_check
        CHECK (status IN ('INVITED', 'ACTIVE', 'INACTIVE', 'SUSPENDED'))
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('ALTER TABLE users DROP CONSTRAINT users_status_check');
    await client.query(`
      ALTER TABLE users ADD CONSTRAINT users_status_check
        CHECK (status IN ('ACTIVE', 'INACTIVE', 'SUSPENDED'))
    `);
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01D — User ↔ Role assignment foundation.
 *
 * Roles are assigned through a join table so a user may hold multiple roles.
 * The partial unique index prevents duplicate ACTIVE assignments for the same
 * user+role pair while still allowing historical REVOKED rows.
 */
export const migration0006CreateUserRoleAssignments: Migration = {
  id: '0006_create_user_role_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE user_role_assignments (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        role_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT user_role_assignments_status_check
          CHECK (status IN ('ACTIVE', 'REVOKED')),
        CONSTRAINT user_role_assignments_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT user_role_assignments_role_id_fkey
          FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX user_role_assignments_active_unique
        ON user_role_assignments (user_id, role_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(
      'CREATE INDEX user_role_assignments_user_id_idx ON user_role_assignments (user_id)',
    );
    await client.query(
      'CREATE INDEX user_role_assignments_role_id_idx ON user_role_assignments (role_id)',
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS user_role_assignments');
  },
};

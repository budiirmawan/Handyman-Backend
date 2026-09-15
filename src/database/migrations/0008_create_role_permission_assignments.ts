import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-01E — Role ↔ Permission assignment foundation.
 *
 * Permissions are assigned through a join table, never embedded in the Role
 * record. The partial unique index prevents duplicate ACTIVE assignments for
 * the same role+permission pair while allowing historical REVOKED rows.
 */
export const migration0008CreateRolePermissionAssignments: Migration = {
  id: '0008_create_role_permission_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE role_permission_assignments (
        id UUID PRIMARY KEY,
        role_id UUID NOT NULL,
        permission_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT role_permission_assignments_status_check
          CHECK (status IN ('ACTIVE', 'REVOKED')),
        CONSTRAINT role_permission_assignments_role_id_fkey
          FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
        CONSTRAINT role_permission_assignments_permission_id_fkey
          FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX role_permission_assignments_active_unique
        ON role_permission_assignments (role_id, permission_id)
        WHERE status = 'ACTIVE'
    `);
    await client.query(
      'CREATE INDEX role_permission_assignments_role_id_idx ON role_permission_assignments (role_id)',
    );
    await client.query(
      'CREATE INDEX role_permission_assignments_permission_id_idx ON role_permission_assignments (permission_id)',
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS role_permission_assignments');
  },
};

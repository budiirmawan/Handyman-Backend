import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-02F — User / Building Assignment foundation.
 *
 * Establishes which Building contexts an authenticated User may access. A User
 * may be assigned to multiple Buildings; assignment does not imply global or
 * sibling access. Client ownership is derived authoritatively through
 * Building → Property → Client (no client_id duplicated here).
 *
 * At most one ACTIVE assignment exists per (user_id, building_id) pair.
 * Inactive assignments are preserved for history — never hard-deleted through
 * normal lifecycle operations.
 */
export const migration0019CreateUserBuildingAssignments: Migration = {
  id: '0019_create_user_building_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE user_building_assignments (
        id UUID PRIMARY KEY,
        user_id UUID NOT NULL,
        building_id UUID NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        assigned_by_user_id UUID,
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT user_building_assignments_user_id_fkey
          FOREIGN KEY (user_id) REFERENCES users (id),
        CONSTRAINT user_building_assignments_building_id_fkey
          FOREIGN KEY (building_id) REFERENCES buildings (id),
        CONSTRAINT user_building_assignments_assigned_by_fkey
          FOREIGN KEY (assigned_by_user_id) REFERENCES users (id),
        CONSTRAINT user_building_assignments_status_check
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX user_building_assignments_one_active_per_user_building
       ON user_building_assignments (user_id, building_id) WHERE status = 'ACTIVE'`,
    );
    await client.query(
      `CREATE INDEX user_building_assignments_user_id_idx
       ON user_building_assignments (user_id)`,
    );
    await client.query(
      `CREATE INDEX user_building_assignments_building_id_idx
       ON user_building_assignments (building_id)`,
    );
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS user_building_assignments');
  },
};

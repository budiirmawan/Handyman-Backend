import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * BE-08E — Work Order Assignment.
 *
 * Assigns a Work Order to an internal Workforce Profile / Team, or to a
 * Vendor / Vendor Workforce member. The assignee masters are the existing
 * BE-03 (workforce_profiles, teams) and BE-06 (vendors,
 * vendor_workforce_bindings) tables — this table holds references only, never
 * duplicate masters.
 *
 * One active assignment per Work Order is enforced by a partial unique index
 * over ACTIVE rows (the same BE-07 idiom), so duplicate/conflicting active
 * assignments are impossible. `assignee_type` + the target reference
 * cross-check guarantee each type addresses exactly the right columns:
 *
 *   WORKFORCE        → workforce_profile_id
 *   TEAM             → team_id
 *   VENDOR           → vendor_id
 *   VENDOR_WORKFORCE → vendor_id + workforce_profile_id
 *
 * Cross-Client / cross-Building and inactive-assignee rules live in the
 * service layer (the FKs only guarantee referential integrity).
 */
export const migration0085CreateWorkOrderAssignments: Migration = {
  id: '0085_create_work_order_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE work_order_assignments (
        id UUID PRIMARY KEY,
        work_order_id UUID NOT NULL REFERENCES work_orders (id),
        assignee_type TEXT NOT NULL,
        workforce_profile_id UUID REFERENCES workforce_profiles (id),
        team_id UUID REFERENCES teams (id),
        vendor_id UUID REFERENCES vendors (id),
        assigned_by_user_id UUID NOT NULL REFERENCES users (id),
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT work_order_assignment_type
          CHECK (assignee_type IN ('WORKFORCE', 'TEAM', 'VENDOR', 'VENDOR_WORKFORCE')),
        CONSTRAINT work_order_assignment_target CHECK (
          (assignee_type = 'WORKFORCE' AND workforce_profile_id IS NOT NULL
             AND team_id IS NULL AND vendor_id IS NULL)
          OR (assignee_type = 'TEAM' AND team_id IS NOT NULL
             AND workforce_profile_id IS NULL AND vendor_id IS NULL)
          OR (assignee_type = 'VENDOR' AND vendor_id IS NOT NULL
             AND workforce_profile_id IS NULL AND team_id IS NULL)
          OR (assignee_type = 'VENDOR_WORKFORCE' AND vendor_id IS NOT NULL
             AND workforce_profile_id IS NOT NULL AND team_id IS NULL)
        ),
        CONSTRAINT work_order_assignment_status
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX work_order_active_assignment_unique
        ON work_order_assignments (work_order_id) WHERE status = 'ACTIVE';
      CREATE INDEX work_order_assignments_work_order_idx
        ON work_order_assignments (work_order_id, status);
      CREATE INDEX work_order_assignments_workforce_idx
        ON work_order_assignments (workforce_profile_id, status);
      CREATE INDEX work_order_assignments_team_idx
        ON work_order_assignments (team_id, status);
      CREATE INDEX work_order_assignments_vendor_idx
        ON work_order_assignments (vendor_id, status);
      CREATE INDEX work_order_assignments_assigner_idx
        ON work_order_assignments (assigned_by_user_id, status);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS work_order_assignments');
  },
};

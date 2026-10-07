import type { PoolClient } from 'pg';
import type { Migration } from './types';

/** BE-09D — generic Finding responsible-party assignment history. */
export const migration0093CreateFindingAssignments: Migration = {
  id: '0093_create_finding_assignments',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE finding_assignments (
        id UUID PRIMARY KEY,
        finding_id UUID NOT NULL REFERENCES findings (id),
        assignee_type TEXT NOT NULL,
        workforce_profile_id UUID REFERENCES workforce_profiles (id),
        team_id UUID REFERENCES teams (id),
        vendor_id UUID REFERENCES vendors (id),
        assigned_by_user_id UUID NOT NULL REFERENCES users (id),
        assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT finding_assignment_type CHECK (
          assignee_type IN ('WORKFORCE', 'TEAM', 'VENDOR', 'VENDOR_WORKFORCE')
        ),
        CONSTRAINT finding_assignment_target CHECK (
          (assignee_type = 'WORKFORCE' AND workforce_profile_id IS NOT NULL
            AND team_id IS NULL AND vendor_id IS NULL)
          OR (assignee_type = 'TEAM' AND team_id IS NOT NULL
            AND workforce_profile_id IS NULL AND vendor_id IS NULL)
          OR (assignee_type = 'VENDOR' AND vendor_id IS NOT NULL
            AND workforce_profile_id IS NULL AND team_id IS NULL)
          OR (assignee_type = 'VENDOR_WORKFORCE' AND vendor_id IS NOT NULL
            AND workforce_profile_id IS NOT NULL AND team_id IS NULL)
        ),
        CONSTRAINT finding_assignment_status
          CHECK (status IN ('ACTIVE', 'INACTIVE'))
      );

      CREATE UNIQUE INDEX finding_active_assignment_unique
        ON finding_assignments (finding_id) WHERE status = 'ACTIVE';
      CREATE INDEX finding_assignments_finding_idx
        ON finding_assignments (finding_id, status, assigned_at);
      CREATE INDEX finding_assignments_workforce_idx
        ON finding_assignments (workforce_profile_id, status);
      CREATE INDEX finding_assignments_team_idx
        ON finding_assignments (team_id, status);
      CREATE INDEX finding_assignments_vendor_idx
        ON finding_assignments (vendor_id, status);
      CREATE INDEX finding_assignments_assigner_idx
        ON finding_assignments (assigned_by_user_id, assigned_at);
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query('DROP TABLE IF EXISTS finding_assignments');
  },
};

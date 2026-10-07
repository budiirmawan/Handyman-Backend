import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * R06 PART 04A — Form Instance Completion Actor + Assignment Snapshot.
 *
 * Mirrors the already-closed checklist attribution authority onto
 * `form_instances` with EXACT semantic parity:
 *
 *   form_instances.completed_by_user_id            →  users.id
 *   form_instances.assignee_type                   TEXT NULL
 *   form_instances.assigned_workforce_profile_id   →  workforce_profiles.id
 *   form_instances.assigned_team_id                →  teams.id
 *   form_instances.assignment_snapshot_at          TIMESTAMPTZ NULL
 *
 * Completion actor = the authenticated user who successfully completed the
 * instance. Assignment snapshot = who/what was assigned at task-bound
 * instance creation. Neither authority proves an actual executor.
 *
 * Assignment contract (enforced by a single CHECK constraint, mirroring the
 * checklist `checklist_executions_assignee_snapshot_check`):
 *   - no assignment → all four fields NULL;
 *   - WORKFORCE     → assignee_type = 'WORKFORCE', assigned_workforce_profile_id
 *                     NOT NULL, assigned_team_id NULL, snapshot_at NOT NULL;
 *   - TEAM          → assignee_type = 'TEAM', assigned_team_id NOT NULL,
 *                     assigned_workforce_profile_id NULL, snapshot_at NOT NULL.
 *
 * FKs reference workforce_profiles and teams directly (NOT task_assignments),
 * so the snapshot survives independently of the live, reassignable assignment
 * table. No backfill: historical form instances remain NULL, and non-task
 * (generic / meter / log-sheet) instances keep all snapshot fields NULL.
 * No executor-named field exists.
 */
export const migration0346AddFormInstanceAttributionSnapshot: Migration = {
  id: '0346_add_form_instance_attribution_snapshot',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE form_instances
        ADD COLUMN completed_by_user_id UUID,
        ADD COLUMN assignee_type TEXT,
        ADD COLUMN assigned_workforce_profile_id UUID,
        ADD COLUMN assigned_team_id UUID,
        ADD COLUMN assignment_snapshot_at TIMESTAMPTZ,
        ADD CONSTRAINT form_instances_completed_by_user_id_fkey
          FOREIGN KEY (completed_by_user_id) REFERENCES users (id),
        ADD CONSTRAINT form_instances_assignee_snapshot_check
          CHECK (
            (assignee_type IS NULL
               AND assigned_workforce_profile_id IS NULL
               AND assigned_team_id IS NULL
               AND assignment_snapshot_at IS NULL)
            OR
            (assignee_type = 'WORKFORCE'
               AND assigned_workforce_profile_id IS NOT NULL
               AND assigned_team_id IS NULL
               AND assignment_snapshot_at IS NOT NULL)
            OR
            (assignee_type = 'TEAM'
               AND assigned_team_id IS NOT NULL
               AND assigned_workforce_profile_id IS NULL
               AND assignment_snapshot_at IS NOT NULL)
          ),
        ADD CONSTRAINT form_instances_assigned_workforce_profile_id_fkey
          FOREIGN KEY (assigned_workforce_profile_id) REFERENCES workforce_profiles (id),
        ADD CONSTRAINT form_instances_assigned_team_id_fkey
          FOREIGN KEY (assigned_team_id) REFERENCES teams (id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE form_instances
        DROP CONSTRAINT IF EXISTS form_instances_assigned_team_id_fkey,
        DROP CONSTRAINT IF EXISTS form_instances_assigned_workforce_profile_id_fkey,
        DROP CONSTRAINT IF EXISTS form_instances_assignee_snapshot_check,
        DROP CONSTRAINT IF EXISTS form_instances_completed_by_user_id_fkey,
        DROP COLUMN IF EXISTS assignment_snapshot_at,
        DROP COLUMN IF EXISTS assigned_team_id,
        DROP COLUMN IF EXISTS assigned_workforce_profile_id,
        DROP COLUMN IF EXISTS assignee_type,
        DROP COLUMN IF EXISTS completed_by_user_id
    `);
  },
};

import type { PoolClient } from 'pg';
import type { Migration } from './types';

/**
 * R06 PART 02 — Checklist Assignment Snapshot Authority.
 *
 * Persists the authoritative task-assignment facts that existed at the moment
 * a task-bound checklist execution was created:
 *
 *   checklist_executions.assignee_type                   TEXT NULL
 *   checklist_executions.assigned_workforce_profile_id   UUID NULL
 *   checklist_executions.assigned_team_id                UUID NULL
 *   checklist_executions.assignment_snapshot_at          TIMESTAMPTZ NULL
 *
 * Contract (enforced by a single CHECK constraint):
 *   - no assignment → all four fields NULL;
 *   - WORKFORCE     → assignee_type = 'WORKFORCE', assigned_workforce_profile_id
 *                     NOT NULL, assigned_team_id NULL, snapshot_at NOT NULL;
 *   - TEAM          → assignee_type = 'TEAM', assigned_team_id NOT NULL,
 *                     assigned_workforce_profile_id NULL, snapshot_at NOT NULL.
 *
 * These fields record WHO/WHAT WAS ASSIGNED at execution creation. They do NOT
 * claim an actual executor / performer — no executor-named field exists.
 *
 * FKs reference workforce_profiles and teams directly (NOT task_assignments),
 * so the snapshot survives independently of the live, reassignable assignment
 * table. No backfill is performed: historical pre-PART rows remain NULL.
 */
export const migration0344AddChecklistExecutionAssignmentSnapshot: Migration = {
  id: '0344_add_checklist_execution_assignment_snapshot',

  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_executions
        ADD COLUMN assignee_type TEXT,
        ADD COLUMN assigned_workforce_profile_id UUID,
        ADD COLUMN assigned_team_id UUID,
        ADD COLUMN assignment_snapshot_at TIMESTAMPTZ,
        ADD CONSTRAINT checklist_executions_assignee_snapshot_check
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
        ADD CONSTRAINT checklist_executions_assigned_workforce_profile_id_fkey
          FOREIGN KEY (assigned_workforce_profile_id) REFERENCES workforce_profiles (id),
        ADD CONSTRAINT checklist_executions_assigned_team_id_fkey
          FOREIGN KEY (assigned_team_id) REFERENCES teams (id)
    `);
  },

  async down(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE checklist_executions
        DROP CONSTRAINT IF EXISTS checklist_executions_assigned_team_id_fkey,
        DROP CONSTRAINT IF EXISTS checklist_executions_assigned_workforce_profile_id_fkey,
        DROP CONSTRAINT IF EXISTS checklist_executions_assignee_snapshot_check,
        DROP COLUMN IF EXISTS assignment_snapshot_at,
        DROP COLUMN IF EXISTS assigned_team_id,
        DROP COLUMN IF EXISTS assigned_workforce_profile_id,
        DROP COLUMN IF EXISTS assignee_type
    `);
  },
};

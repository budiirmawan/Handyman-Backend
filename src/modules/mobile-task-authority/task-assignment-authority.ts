import { getPool } from '../../database';
import { workforceRepository } from '../workforce/workforce.repository';

/**
 * MOB-C04 / MOB-C07 — Worker executability of a generated task via the
 * existing WORKFORCE / TEAM assignment authority.
 *
 * Extracted from C04 so mobile form open reuses the same rule without a
 * weaker copy. C04 behavior is unchanged:
 *   - no ACTIVE assignment             → not executable
 *   - WORKFORCE assignment to another  → not executable
 *     workforce profile
 *   - WORKFORCE assignment to this     → executable
 *     profile
 *   - TEAM-only assignment to the      → executable
 *     caller's team
 *
 * If any ACTIVE WORKFORCE assignment exists, TEAM is ignored (the work is
 * held by a specific profile). TEAM matching requires a non-null
 * `profile.teamId`. Inactive / missing workforce profiles are not executable.
 */
export async function isBoundTaskExecutableByUser(
  taskId: string,
  userId: string,
): Promise<boolean> {
  const profile = await workforceRepository.findByUserId(userId);
  if (!profile || profile.status !== 'ACTIVE') {
    return false;
  }

  const assignments = await getPool().query<{
    assignee_type: 'WORKFORCE' | 'TEAM';
    workforce_profile_id: string | null;
    team_id: string | null;
  }>(
    `SELECT assignee_type, workforce_profile_id, team_id
       FROM task_assignments
      WHERE task_id = $1 AND status = 'ACTIVE'`,
    [taskId],
  );
  if (assignments.rowCount === 0) {
    return false;
  }

  const workforceAssignments = assignments.rows.filter(
    (row) => row.assignee_type === 'WORKFORCE',
  );
  if (workforceAssignments.length > 0) {
    return workforceAssignments.some(
      (row) => row.workforce_profile_id === profile.id,
    );
  }

  const teamAssignments = assignments.rows.filter(
    (row) => row.assignee_type === 'TEAM' && row.team_id,
  );
  return (
    profile.teamId !== null &&
    teamAssignments.some((row) => row.team_id === profile.teamId)
  );
}

/**
 * R06 PART 02 — resolves the single ACTIVE task assignment facts of a
 * generated task (the same `task_assignments` authority the executability
 * gate reads). `null` when there is no ACTIVE assignment.
 *
 * These are ASSIGNMENT facts only — they never prove an actual executor.
 */
export type ActiveTaskAssignmentFacts = {
  assigneeType: 'WORKFORCE' | 'TEAM';
  workforceProfileId: string | null;
  teamId: string | null;
};

export async function resolveActiveTaskAssignment(
  taskId: string,
): Promise<ActiveTaskAssignmentFacts | null> {
  const result = await getPool().query<{
    assignee_type: 'WORKFORCE' | 'TEAM';
    workforce_profile_id: string | null;
    team_id: string | null;
  }>(
    `SELECT assignee_type, workforce_profile_id, team_id
       FROM task_assignments
      WHERE task_id = $1 AND status = 'ACTIVE'`,
    [taskId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    assigneeType: row.assignee_type,
    workforceProfileId: row.workforce_profile_id,
    teamId: row.team_id,
  };
}

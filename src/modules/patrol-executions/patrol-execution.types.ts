/**
 * BE-12D — Patrol Execution domain types.
 *
 * A Patrol Execution is the Security operational view of an authoritative
 * BE-07 scheduled task (`generated_tasks`) bound to a BE-12B Patrol Route
 * via a BE-12C Patrol Schedule Binding. The Task lifecycle/status remain
 * authoritative in BE-07; this module only adds the Security-specific
 * context (Route, Schedule Binding, Start Post, Point Visits).
 *
 * The shared task status is re-exported as the execution status because it
 * is the same enum (`OPEN | ASSIGNED | IN_PROGRESS | COMPLETED | CANCELLED`).
 * No duplicate lifecycle here.
 */
export const PATROL_EXECUTION_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type PatrolExecutionStatus =
  (typeof PATROL_EXECUTION_STATUSES)[number];

export function isPatrolExecutionStatus(
  value: unknown,
): value is PatrolExecutionStatus {
  return (
    typeof value === 'string' &&
    (PATROL_EXECUTION_STATUSES as readonly string[]).includes(value)
  );
}

export const TERMINAL_PATROL_EXECUTION_STATUSES: readonly PatrolExecutionStatus[] =
  ['COMPLETED', 'CANCELLED'];

/** Full database record (raw snake_case row for cross-module reads). */
export type PatrolExecutionRow = {
  task_id: string;
  client_id: string;
  building_id: string;
  occurrence_at: Date;
  status: PatrolExecutionStatus;
  started_at: Date | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_notes: string | null;
  created_at: Date;
  updated_at: Date;
  schedule_binding_id: string;
  start_security_post_id: string | null;
  schedule_definition_id: string;
  patrol_route_id: string;
  patrol_route_code: string;
  patrol_route_name: string;
  patrol_route_status: string;
  start_security_post_code: string | null;
  start_security_post_name: string | null;
  schedule_code: string;
  schedule_name: string;
  target_type: string;
  target_id: string;
  schedule_status: string;
};

/** Public API representation. */
export type PublicPatrolExecution = {
  id: string;
  taskId: string;
  clientId: string;
  buildingId: string;
  patrolRouteId: string;
  scheduleBindingId: string;
  scheduleDefinitionId: string;
  startSecurityPostId: string | null;
  operationalDate: string;
  occurrenceAt: string;
  status: PatrolExecutionStatus;
  startedAt: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  patrolRoute: {
    id: string;
    code: string;
    name: string;
    status: string;
  };
  startSecurityPost: {
    id: string | null;
    code: string | null;
    name: string | null;
  };
  schedule: {
    id: string;
    code: string;
    name: string;
    targetType: string;
    targetId: string;
    status: string;
  };
  pointProgress: {
    totalPoints: number;
    visitedPoints: number;
    pendingPoints: number;
    nextSequence: number | null;
  };
  createdAt: string;
  updatedAt: string;
};

export type PublicPatrolPointVisit = {
  id: string;
  clientId: string;
  buildingId: string;
  taskId: string;
  patrolRouteId: string;
  patrolRoutePointId: string;
  sequence: number;
  visitedAt: string;
  visitedByUserId: string;
  notes: string | null;
  status: 'VISITED' | 'INACTIVE';
  createdAt: string;
  updatedAt: string;
};

export type PatrolExecutionFilter = {
  date?: string;
  status?: PatrolExecutionStatus;
  patrolRouteId?: string;
};

export type PatrolPointVisitInput = {
  patrolRoutePointId: string;
  notes?: string | null;
};

export type UpdatePatrolPointVisitInput = {
  notes?: string | null;
};

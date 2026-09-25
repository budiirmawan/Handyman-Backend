export {
  patrolExecutionBindingInactiveError,
  patrolExecutionBuildingMismatchError,
  patrolExecutionClientMismatchError,
  patrolExecutionIncompleteError,
  patrolExecutionInvalidStateError,
  patrolExecutionNoAssignmentError,
  patrolExecutionNotFoundError,
  patrolExecutionRouteInactiveError,
  patrolExecutionTerminalError,
  patrolExecutionUnauthorizedError,
  patrolPointVisitDuplicateError,
  patrolPointVisitExecutionMismatchError,
  patrolPointVisitNotFoundError,
  patrolPointVisitRouteMismatchError,
  patrolPointVisitTerminalError,
} from './patrol-execution.errors';

export {
  patrolExecutionRepository,
} from './patrol-execution.repository';

export {
  createPatrolExecutionRouter,
} from './patrol-execution.routes';

export {
  completePatrolExecution,
  getPatrolExecutionById,
  getPatrolFieldContext,
  listPatrolExecutionsByBuilding,
  listPatrolPointVisits,
  operationalDateWindow,
  patrolExecutionService,
  recordPatrolPointVisit,
  startPatrolExecution,
  toPublicPatrolExecution,
  updatePatrolPointVisit,
} from './patrol-execution.service';

export {
  PATROL_EXECUTION_STATUSES,
  PATROL_FIELD_ACTIONS,
  PATROL_POINT_FIELD_ACTIONS,
  TERMINAL_PATROL_EXECUTION_STATUSES,
  isPatrolExecutionStatus,
  type PatrolExecutionFilter,
  type PatrolExecutionRow,
  type PatrolExecutionStatus,
  type PatrolFieldAction,
  type PatrolFieldContext,
  type PatrolFieldPoint,
  type PatrolPointFieldAction,
  type PatrolPointVisitInput,
  type PublicPatrolExecution,
  type PublicPatrolPointVisit,
  type UpdatePatrolPointVisitInput,
} from './patrol-execution.types';

export {
  parseCompleteBody,
  parsePatrolExecutionBuildingIdParam,
  parsePatrolExecutionFilter,
  parsePatrolExecutionIdParam,
  parsePatrolExecutionPointIdParam,
  parsePatrolExecutionVisitIdParam,
  parseUpdateVisitBody,
  parseVisitBody,
} from './patrol-execution.validation';

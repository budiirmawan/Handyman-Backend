export {
  workOrderAssignmentAlreadyAssignedError,
  workOrderAssignmentBuildingMismatchError,
  workOrderAssignmentClientMismatchError,
  workOrderAssignmentInvalidStateError,
  workOrderAssignmentNotFoundError,
  workOrderAssignmentVendorWorkforceMismatchError,
} from './work-order-assignment.errors';

export { workOrderAssignmentRepository } from './work-order-assignment.repository';

export {
  assignWorkOrder,
  deactivateWorkOrderAssignment,
  getCurrentWorkOrderAssignment,
  listWorkOrderAssignments,
  reassignWorkOrder,
  toPublicWorkOrderAssignment,
  workOrderAssignmentService,
} from './work-order-assignment.service';

export {
  WORK_ORDER_ASSIGNABLE_STATUSES,
  WORK_ORDER_ASSIGNEE_TYPES,
  WORK_ORDER_ASSIGNMENT_STATUSES,
  isWorkOrderAssigneeType,
  isWorkOrderAssignableStatus,
  isWorkOrderAssignmentStatus,
} from './work-order-assignment.types';

export {
  parseAssignWorkOrderBody,
  parseAssignmentIdParam,
  parseUpdateAssignmentBody,
  parseWorkOrderIdParam,
} from './work-order-assignment.validation';

export { createWorkOrderAssignmentRouter } from './work-order-assignment.routes';

export type {
  AssignWorkOrderInput,
  NewWorkOrderAssignment,
  PublicWorkOrderAssignment,
  UpdateWorkOrderAssignmentInput,
  WorkOrderAssignmentRecord,
  WorkOrderAssignmentStatus,
  WorkOrderAssigneeType,
} from './work-order-assignment.types';

export type { ValidationDetail } from './work-order-assignment.validation';

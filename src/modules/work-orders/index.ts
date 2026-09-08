export {
  workOrderAssetBuildingMismatchError,
  workOrderAssetLocationInconsistentError,
  workOrderBastRequirementLockedError,
  workOrderBuildingClientMismatchError,
  workOrderCompletionAlreadyCompletedError,
  workOrderCompletionEvidenceIncompleteError,
  workOrderCompletionInvalidStateError,
  workOrderCompletionNoAssignmentError,
  workOrderCompletionUnauthorizedError,
  workOrderFromRequestAlreadyExistsError,
  workOrderInvalidTransitionError,
  workOrderLocationBuildingMismatchError,
  workOrderLocationInactiveError,
  workOrderNotFoundError,
  workOrderNotOpenError,
  workOrderNumberAlreadyExistsError,
} from './work-order.errors';

export { workOrderRepository } from './work-order.repository';

export {
  bindWorkOrderContext,
  completeWorkOrder,
  createWorkOrder,
  createWorkOrderFromRequest,
  getWorkOrderById,
  getWorkOrderCompletion,
  getWorkOrderContext,
  listWorkOrdersByBuilding,
  toPublicWorkOrder,
  transitionWorkOrderStatus,
  updateWorkOrder,
  updateWorkOrderBastRequirement,
  updateWorkOrderPriority,
  validateWorkOrderCompletionReadiness,
  workOrderService,
} from './work-order.service';

export {
  BAST_REQUIREMENTS,
  WORK_ORDER_PRIORITIES,
  WORK_ORDER_STATUSES,
  WORK_ORDER_TRANSITIONS,
  canTransitionWorkOrderStatus,
  isBastRequirement,
  isWorkOrderPriority,
  isWorkOrderStatus,
} from './work-order.types';

export {
  isValidWorkOrderNumber,
  isValidWorkType,
  normalizeWorkOrderNumber,
  normalizeWorkType,
  parseCompleteWorkOrderBody,
  parseCreateWorkOrderBody,
  parseCreateWorkOrderFromRequestBody,
  parseUpdateWorkOrderBastRequirementBody,
  parseUpdateWorkOrderBody,
  parseUpdateWorkOrderContextBody,
  parseUpdateWorkOrderPriorityBody,
  parseUpdateWorkOrderStatusBody,
  parseWorkOrderBuildingIdParam,
  parseWorkOrderFilters,
  parseWorkOrderIdParam,
} from './work-order.validation';

export { createWorkOrderRouter } from './work-order.routes';

export type {
  BastRequirement,
  CompleteWorkOrderInput,
  CompleteWorkOrderServiceInput,
  CreateWorkOrderFromRequestInput,
  CreateWorkOrderInput,
  NewWorkOrder,
  PublicWorkOrder,
  UpdateWorkOrderBastRequirementInput,
  UpdateWorkOrderContextInput,
  UpdateWorkOrderInput,
  UpdateWorkOrderPriorityInput,
  UpdateWorkOrderStatusInput,
  WorkOrderCompletionReadiness,
  WorkOrderContext,
  WorkOrderFilters,
  WorkOrderPriority,
  WorkOrderRecord,
  WorkOrderStatus,
} from './work-order.types';

export type { ValidationDetail } from './work-order.validation';

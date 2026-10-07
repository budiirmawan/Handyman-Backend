/**
 * CR-HM-09 PART 01 — material execution persistence module barrel.
 */

export {
  HANDYMAN_MATERIAL_EXECUTION_STATUSES,
  HANDYMAN_MATERIAL_EXECUTION_EVENT_TYPES,
  isHandymanMaterialExecutionStatus,
  isHandymanMaterialExecutionEventType,
} from './handyman-material-execution.types';
export type {
  HandymanMaterialExecutionStatus,
  HandymanMaterialAcquisitionMode,
  HandymanMaterialExecutionEventType,
  HandymanMaterialExecutionLineRecord,
  HandymanMaterialExecutionLineHead,
  HandymanMaterialExecutionEventRecord,
  HandymanMaterialExecutionProgressRecord,
  HandymanMaterialExecutionProgressLine,
  HandymanMaterialFinalChargeReadyLine,
  HandymanMaterialFinalUsedByUom,
  HandymanMaterialIdentity,
  HandymanMaterialUom,
  NewHandymanMaterialExecutionLine,
  NewHandymanMaterialExecutionEvent,
} from './handyman-material-execution.types';

export {
  handymanMaterialExecutionLineNotFoundError,
  handymanMaterialExecutionNotAuthorizedError,
  handymanMaterialExecutionScopeNotEligibleError,
  handymanMaterialExecutionLinkInvalidError,
  handymanMaterialExecutionEstimateInvalidError,
  handymanMaterialExecutionQuantityExceededError,
  handymanMaterialExecutionLinkConflictError,
  handymanMaterialExecutionIllegalTransitionError,
  handymanMaterialExecutionValidationError,
} from './handyman-material-execution.errors';

export {
  estimateHandymanMaterialExecutionLine,
  approveHandymanMaterialExecutionLine,
  issueHandymanMaterialExecutionLine,
  purchaseHandymanMaterialExecutionLine,
  useHandymanMaterialExecutionLine,
  returnHandymanMaterialExecutionLine,
  settleHandymanMaterialExecutionLine,
  getHandymanMaterialProgressProjection,
  getHandymanMaterialFinalChargeReadyProjection,
  getHandymanMaterialLinesCustomerCareView,
  listHandymanMaterialLinesByScope,
} from './handyman-material-execution.service';
export type {
  EstimateHandymanMaterialLineInput,
  ApproveHandymanMaterialLineInput,
  AcquireHandymanMaterialLineInput,
  UsageHandymanMaterialLineInput,
  SettleHandymanMaterialLineInput,
  HandymanCustomerCareMaterialLineItem,
  HandymanCustomerCareMaterialLinesProjection,
  HandymanMaterialExecutionCommandResult,
  HandymanMaterialFinalChargeReadyProjection,
  HandymanMaterialProgressProjection,
} from './handyman-material-execution.types';

export {
  HANDYMAN_MATERIAL_QUANTITY_MAX,
  HANDYMAN_MATERIAL_QUANTITY_SCALE,
  handymanMaterialQuantityFromUnits,
  handymanMaterialQuantityUnits,
  isHandymanMaterialQuantityRepresentable,
} from './handyman-material-execution.quantity';

export { handymanMaterialExecutionRepository }
  from './handyman-material-execution.repository';

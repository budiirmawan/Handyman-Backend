/**
 * Backend-only work-session persistence and command surface, including
 * CHECK_IN arrival binding. No HTTP/OpenAPI authority is exposed here.
 */
export {
  HANDYMAN_WORK_SESSION_EVENT_TYPES,
  HANDYMAN_WORK_SESSION_STATUSES,
  isHandymanWorkSessionEventType,
  isHandymanWorkSessionStatus,
} from './handyman-work-session.types';
export type {
  HandymanWorkSessionEventRecord,
  HandymanWorkSessionEventType,
  HandymanWorkSessionHelperPresenceRecord,
  HandymanWorkSessionRecord,
  HandymanWorkSessionStatus,
  NewHandymanWorkSession,
  NewHandymanWorkSessionEvent,
  NewHandymanWorkSessionHelperPresence,
} from './handyman-work-session.types';
export {
  handymanWorkSessionActiveConflictError,
  handymanWorkSessionArrivalRequiredError,
  handymanWorkSessionIllegalTransitionError,
  handymanWorkSessionNotAuthorizedError,
  handymanWorkSessionNotFoundError,
  handymanWorkSessionScopeNotEligibleError,
  handymanWorkSessionStaleConflictError,
  handymanWorkSessionValidationError,
} from './handyman-work-session.errors';
export { handymanWorkSessionRepository }
  from './handyman-work-session.repository';
export {
  HANDYMAN_CHECK_IN_ARRIVAL_FRESHNESS_SECONDS,
  checkInHandymanWorkSession,
  checkOutHandymanWorkSession,
  completeHandymanWorkSession,
  getActiveHandymanWorkSession,
  getHandymanWorkSessionsCustomerCareView,
  getHandymanWorkSessionTimeProjection,
  listHandymanWorkSessionsByScope,
  materialRunHandymanWorkSession,
  pauseHandymanWorkSession,
  resumeHandymanWorkSession,
  startWorkHandymanWorkSession,
} from './handyman-work-session.service';
export type {
  HandymanCustomerCareWorkSessionItem,
  HandymanCustomerCareWorkSessionsProjection,
  HandymanWorkSessionCheckInInput,
  HandymanWorkSessionCheckInResult,
  HandymanWorkSessionStartWorkInput,
  HandymanWorkSessionStartWorkResult,
  HandymanWorkSessionActiveResult,
  HandymanWorkSessionTimeProjection,
  HandymanWorkSessionWorkClockResult,
} from './handyman-work-session.service';

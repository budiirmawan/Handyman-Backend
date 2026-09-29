/**
 * CR-HM-08 PART 01 — work-session persistence foundation barrel.
 * Repository + bounded types/errors ONLY: no commands, no transition
 * decisions, no arrival gate, no HTTP/OpenAPI.
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
  handymanWorkSessionValidationError,
} from './handyman-work-session.errors';
export { handymanWorkSessionRepository }
  from './handyman-work-session.repository';
export {
  checkInHandymanWorkSession,
  materialRunHandymanWorkSession,
  pauseHandymanWorkSession,
  resumeHandymanWorkSession,
  startWorkHandymanWorkSession,
} from './handyman-work-session.service';
export type {
  HandymanWorkSessionCheckInInput,
  HandymanWorkSessionCheckInResult,
  HandymanWorkSessionStartWorkInput,
  HandymanWorkSessionStartWorkResult,
  HandymanWorkSessionWorkClockResult,
} from './handyman-work-session.service';

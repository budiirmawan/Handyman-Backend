/**
 * CR-HM-11 PART 02 — Handyman BAST aggregate barrel.
 * No HTTP/OpenAPI. ACCEPT/REJECT are state-gated here.
 */

export {
  HANDYMAN_BAST_STATUSES,
  HANDYMAN_BAST_PART01_EVENT_TYPES,
  HANDYMAN_BAST_PART02_EVENT_TYPES,
  HANDYMAN_BAST_EVENT_TYPES,
  isHandymanBastStatus,
  isHandymanBastPart01EventType,
  isHandymanBastEventType,
} from './handyman-bast.types';
export type {
  HandymanBastStatus,
  HandymanBastPart01EventType,
  HandymanBastPart02EventType,
  HandymanBastEventType,
  HandymanBastRecord,
  HandymanBastEventRecord,
  HandymanBastSignOffRecord,
  NewHandymanBast,
  NewHandymanBastEvent,
  NewHandymanBastSignOff,
} from './handyman-bast.types';

export {
  handymanBastNotFoundError,
  handymanBastScopeNotEligibleError,
  handymanBastIllegalTransitionError,
  handymanBastSignOffReservedError,
  handymanBastSignatureRequiredError,
  handymanBastActiveConflictError,
  handymanBastValidationError,
} from './handyman-bast.errors';

export {
  nextHandymanBastStatus,
  assertHandymanBastSignature,
  isPart01BastAction,
} from './handyman-bast.lifecycle';

export { handymanBastRepository } from './handyman-bast.repository';

export {
  prepareHandymanBast,
  issueHandymanBast,
  voidHandymanBast,
  acceptHandymanBast,
  rejectHandymanBast,
  getHandymanBastById,
} from './handyman-bast.service';
export type {
  HandymanBastPrepareInput,
  HandymanBastTransitionInput,
  HandymanBastSignOffInput,
  HandymanBastCommandResult,
} from './handyman-bast.service';

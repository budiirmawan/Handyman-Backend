/**
 * CR-HM-11 PART 01 — Handyman BAST aggregate barrel.
 * No HTTP/OpenAPI. No ACCEPT/REJECT.
 */

export {
  HANDYMAN_BAST_STATUSES,
  HANDYMAN_BAST_PART01_EVENT_TYPES,
  isHandymanBastStatus,
  isHandymanBastPart01EventType,
} from './handyman-bast.types';
export type {
  HandymanBastStatus,
  HandymanBastPart01EventType,
  HandymanBastRecord,
  HandymanBastEventRecord,
  NewHandymanBast,
  NewHandymanBastEvent,
} from './handyman-bast.types';

export {
  handymanBastNotFoundError,
  handymanBastScopeNotEligibleError,
  handymanBastIllegalTransitionError,
  handymanBastSignOffReservedError,
  handymanBastActiveConflictError,
  handymanBastValidationError,
} from './handyman-bast.errors';

export {
  nextHandymanBastStatus,
  isPart01BastAction,
} from './handyman-bast.lifecycle';

export { handymanBastRepository } from './handyman-bast.repository';

export {
  prepareHandymanBast,
  issueHandymanBast,
  voidHandymanBast,
  getHandymanBastById,
} from './handyman-bast.service';
export type {
  HandymanBastPrepareInput,
  HandymanBastTransitionInput,
  HandymanBastCommandResult,
} from './handyman-bast.service';

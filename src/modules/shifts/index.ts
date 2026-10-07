export {
  shiftBuildingClientMismatchError,
  shiftCodeAlreadyExistsError,
  shiftInactiveError,
  shiftNotFoundError,
} from './shift.errors';

export { shiftRepository } from './shift.repository';

export {
  createShift,
  getShiftById,
  listShiftsByBuilding,
  resolveBuildingClientId,
  shiftService,
  toPublicShift,
  updateShiftStatus,
} from './shift.service';

export { SHIFT_STATUSES, isShiftStatus } from './shift.types';

export {
  isValidShiftCode,
  normalizeShiftCode,
  normalizeTime,
  parseCreateShiftBody,
  parseShiftBuildingIdParam,
  parseShiftIdParam,
  parseUpdateShiftStatusBody,
} from './shift.validation';

export { createShiftRouter } from './shift.routes';

export type {
  CreateShiftInput,
  NewShift,
  PublicShift,
  ShiftRecord,
  ShiftStatus,
  UpdateShiftStatusInput,
} from './shift.types';

export type { CreateShiftBody, ValidationDetail } from './shift.validation';

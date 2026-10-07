export {
  utilityMeterBuildingInactiveError,
  utilityMeterCodeAlreadyExistsError,
  utilityMeterInactiveError,
  utilityMeterLocationMismatchError,
  utilityMeterNotFoundError,
  utilityMeterUomClientMismatchError,
  utilityMeterUomInactiveError,
  utilityMeterUomNotFoundError,
} from './utility-meter.errors';

export { utilityMeterRepository } from './utility-meter.repository';

export {
  createUtilityMeter,
  getUtilityMeterById,
  listUtilityMetersByBuilding,
  listUtilityMetersByClient,
  toPublicUtilityMeter,
  updateUtilityMeter,
  updateUtilityMeterStatus,
  utilityMeterService,
} from './utility-meter.service';

export {
  UTILITY_METER_PURPOSES,
  UTILITY_METER_STATUSES,
  UTILITY_TYPES,
  isUtilityMeterPurpose,
  isUtilityMeterStatus,
  isUtilityType,
} from './utility-meter.types';

export {
  isValidUtilityMeterCode,
  normalizeUtilityMeterCode,
  parseCreateUtilityMeterBody,
  parseUpdateUtilityMeterBody,
  parseUpdateUtilityMeterStatusBody,
  parseUtilityMeterBuildingIdParam,
  parseUtilityMeterClientIdParam,
  parseUtilityMeterIdParam,
} from './utility-meter.validation';

export type {
  CreateUtilityMeterInput,
  NewUtilityMeter,
  PublicUtilityMeter,
  UpdateUtilityMeterInput,
  UpdateUtilityMeterStatusInput,
  UtilityMeterFilters,
  UtilityMeterPurpose,
  UtilityMeterRecord,
  UtilityMeterStatus,
  UtilityType,
} from './utility-meter.types';

export type { ValidationDetail } from './utility-meter.validation';

export { createUtilityMeterRouter } from './utility-meter.routes';

export {
  utilityMeterReadingAlreadyExistsError,
  utilityMeterReadingImmutableError,
  utilityMeterReadingNotFoundError,
  utilityMeterReadingTenantMismatchError,
  utilityMeterReadingUomMismatchError,
  utilityMeterReadingValueInvalidError,
} from './utility-meter-reading.errors';

export { utilityMeterReadingRepository } from './utility-meter-reading.repository';
export type { UtilityMeterReadingExecutor } from './utility-meter-reading.repository';

export {
  getLatestReadingForMeter,
  getUtilityMeterReadingById,
  listReadingsByBuilding,
  listReadingsByMeter,
  listReadingsByTenantCompany,
  recordUtilityMeterReading,
  toPublicUtilityMeterReading,
  utilityMeterReadingService,
} from './utility-meter-reading.service';

export {
  UTILITY_METER_READING_SOURCES,
  UTILITY_METER_READING_TYPES,
  isUtilityMeterReadingSource,
  isUtilityMeterReadingType,
} from './utility-meter-reading.types';

export {
  parseReadingBuildingIdParam,
  parseReadingDateQuery,
  parseReadingLimitQuery,
  parseReadingMeterIdParam,
  parseReadingSourceQuery,
  parseReadingTenantIdParam,
  parseReadingTypeQuery,
  parseReadingUuidQuery,
  parseRecordUtilityMeterReadingBody,
  parseUtilityMeterReadingIdParam,
} from './utility-meter-reading.validation';

export type {
  NewUtilityMeterReading,
  PublicUtilityMeterReading,
  ReadingMeterSummary,
  ReadingUomSummary,
  RecordUtilityMeterReadingInput,
  UtilityMeterReadingFilters,
  UtilityMeterReadingRecord,
  UtilityMeterReadingSource,
  UtilityMeterReadingType,
} from './utility-meter-reading.types';

export type { ValidationDetail } from './utility-meter-reading.validation';

export { createUtilityMeterReadingRouter } from './utility-meter-reading.routes';

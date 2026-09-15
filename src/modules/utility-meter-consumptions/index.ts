export {
  utilityMeterConsumptionAlreadyExistsError,
  utilityMeterConsumptionNegativeError,
  utilityMeterConsumptionNotFoundError,
  utilityMeterConsumptionPeriodInvalidError,
  utilityMeterConsumptionReadingInvalidError,
  utilityMeterConsumptionTenantMismatchError,
  utilityMeterConsumptionUomMismatchError,
} from './utility-meter-consumption.errors';

export { utilityMeterConsumptionRepository } from './utility-meter-consumption.repository';

export {
  calculateUtilityMeterConsumption,
  getLatestConsumptionForMeter,
  getUtilityMeterConsumptionById,
  listConsumptionsByBuilding,
  listConsumptionsByMeter,
  listConsumptionsByTenantCompany,
  readUtilityConsumptionTrend,
  toPublicUtilityMeterConsumption,
  utilityMeterConsumptionService,
} from './utility-meter-consumption.service';

export {
  parseCalculateUtilityMeterConsumptionBody,
  parseConsumptionBuildingIdParam,
  parseConsumptionDateQuery,
  parseConsumptionLimitQuery,
  parseConsumptionMeterIdParam,
  parseConsumptionTenantIdParam,
  parseConsumptionUuidQuery,
  parseUtilityMeterConsumptionIdParam,
} from './utility-meter-consumption.validation';

export type {
  CalculateUtilityMeterConsumptionInput,
  ConsumptionMeterSummary,
  ConsumptionReadingSummary,
  ConsumptionUomSummary,
  NewUtilityMeterConsumption,
  PublicUtilityConsumptionTrendBucket,
  PublicUtilityMeterConsumption,
  UtilityConsumptionTrendReadRequest,
  UtilityConsumptionTrendSourceRow,
  UtilityMeterConsumptionFilters,
  UtilityMeterConsumptionRecord,
} from './utility-meter-consumption.types';

export type { ValidationDetail } from './utility-meter-consumption.validation';

export { createUtilityMeterConsumptionRouter } from './utility-meter-consumption.routes';

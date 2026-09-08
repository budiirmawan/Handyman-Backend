export {
  utilityCalculationAlreadyExistsError,
  utilityCalculationAlreadyFinalizedError,
  utilityCalculationBasisInvalidError,
  utilityCalculationBasisNotFoundError,
  utilityCalculationConsumptionInvalidError,
  utilityCalculationNotFoundError,
  utilityCalculationNotRecalculableError,
  utilityCalculationPeriodInvalidError,
  utilityCalculationTenantMismatchError,
} from './utility-calculation.errors';

export { utilityCalculationRepository } from './utility-calculation.repository';

export {
  calculateUtilityValue,
  createUtilityCalculationBasis,
  finalizeUtilityCalculation,
  getUtilityCalculationById,
  listCalculationsByBuilding,
  listCalculationsByConsumption,
  listCalculationsByMeter,
  listCalculationsByTenantCompany,
  listUtilityCalculationBases,
  recalculateUtilityValue,
  toPublicUtilityCalculation,
  toPublicUtilityCalculationBasis,
  utilityCalculationService,
} from './utility-calculation.service';

export {
  UTILITY_CALCULATION_BASIS_STATUSES,
  UTILITY_CALCULATION_STATUSES,
  isUtilityCalculationBasisStatus,
  isUtilityCalculationStatus,
} from './utility-calculation.types';

export type {
  CalculateUtilityValueInput,
  CalculationConsumptionSummary,
  CalculationMeterSummary,
  CalculationUomSummary,
  CreateUtilityCalculationBasisInput,
  NewUtilityCalculation,
  NewUtilityCalculationBasis,
  PublicUtilityCalculation,
  PublicUtilityCalculationBasis,
  RecalculateUtilityValueInput,
  UtilityCalculationBasisFilters,
  UtilityCalculationBasisRecord,
  UtilityCalculationBasisStatus,
  UtilityCalculationFilters,
  UtilityCalculationRecord,
  UtilityCalculationScope,
  UtilityCalculationStatus,
} from './utility-calculation.types';

export {
  parseCalculateUtilityValueBody,
  parseCalculationBuildingIdParam,
  parseCalculationClientIdParam,
  parseCalculationConsumptionIdParam,
  parseCalculationDateQuery,
  parseCalculationLimitQuery,
  parseCalculationMeterIdParam,
  parseCalculationStatusQuery,
  parseCalculationTenantIdParam,
  parseCalculationUtilityTypeQuery,
  parseCalculationUuidQuery,
  parseCreateUtilityCalculationBasisBody,
  parseRecalculateUtilityValueBody,
  parseUtilityCalculationIdParam,
} from './utility-calculation.validation';

export type {
  CalculateUtilityValueBody,
  CreateUtilityCalculationBasisBody,
  RecalculateUtilityValueBody,
  ValidationDetail,
} from './utility-calculation.validation';

export { createUtilityCalculationRouter } from './utility-calculation.routes';

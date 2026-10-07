export {
  utilityAggregationPeriodInvalidError,
  utilityAggregationScopeRequiredError,
} from './utility-aggregation.errors';

export { utilityAggregationRepository } from './utility-aggregation.repository';

export {
  aggregateUtilityConsumption,
  getUtilityAbnormalSummary,
  getUtilitySummary,
  getUtilityVerificationApprovalSummary,
  utilityAggregationService,
} from './utility-aggregation.service';

export {
  UTILITY_AGGREGATION_GROUPINGS,
  UTILITY_AGGREGATION_INTERVALS,
  UTILITY_AGGREGATION_METER_SCOPES,
  isUtilityAggregationGrouping,
  isUtilityAggregationInterval,
  isUtilityAggregationMeterScope,
} from './utility-aggregation.types';

export type {
  UtilityAbnormalSummary,
  UtilityAggregationBucket,
  UtilityAggregationFilters,
  UtilityAggregationGrouping,
  UtilityAggregationInterval,
  UtilityAggregationMeterScope,
  UtilityAggregationRow,
  UtilityAggregationScope,
  UtilityAggregationSummary,
  UtilityConsumptionTotals,
  UtilityVerificationApprovalSummary,
} from './utility-aggregation.types';

export {
  parseAggregationFiltersQuery,
  parseAggregationGroupingQuery,
  parseAggregationScopeQuery,
} from './utility-aggregation.validation';

export type { ValidationDetail } from './utility-aggregation.validation';

export { createUtilityAggregationRouter } from './utility-aggregation.routes';

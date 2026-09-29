/**
 * CR-HM-12 PART 02 — Handyman labor & crew pricing basis barrel.
 * Domain module ONLY: no controller, no routes, no HTTP, no OpenAPI.
 * Material basis is PART 03; BM fee rules are PART 04; the published
 * read contract for CR-HM-06/14/17 is PART 05.
 */

export {
  HANDYMAN_LABOR_PRICING_MODES,
  HANDYMAN_CREW_PRICING_MODES,
  HANDYMAN_BILLABLE_TIME_BASES,
  HANDYMAN_LABOR_PRICING_CURRENCIES,
  isHandymanLaborPricingMode,
  isHandymanCrewPricingMode,
  isHandymanBillableTimeBasis,
  isHandymanLaborPricingCurrency,
} from './handyman-labor-pricing.types';
export type {
  HandymanLaborPricingMode,
  HandymanCrewPricingMode,
  HandymanBillableTimeBasis,
  HandymanLaborPricingCurrency,
  HandymanLaborPricingBasisRecord,
  NewHandymanLaborPricingBasis,
} from './handyman-labor-pricing.types';

export {
  handymanLaborPricingBasisNotFoundError,
  handymanLaborPricingVersionNotDraftError,
  handymanLaborPricingModeConflictError,
  handymanLaborPricingKeyConflictError,
  handymanLaborPricingBasisNotEffectiveError,
  handymanLaborPricingValidationError,
} from './handyman-labor-pricing.errors';

export {
  assertHandymanLaborPricingShape,
  parseHandymanLaborUnitAmount,
  evaluateHandymanLaborPricingBasis,
} from './handyman-labor-pricing.evaluate';
export type {
  HandymanLaborPricingBasisFacts,
  HandymanLaborPricingExecuteInput,
  HandymanLaborPricingBasisResult,
} from './handyman-labor-pricing.evaluate';

export { handymanLaborPricingRepository }
  from './handyman-labor-pricing.repository';

export {
  prepareHandymanLaborPricingBasis,
  listHandymanLaborPricingBasisForVersion,
  resolveHandymanLaborPricingBasisAt,
} from './handyman-labor-pricing.service';
export type {
  HandymanLaborPricingBasisPrepareInput,
  HandymanLaborPricingBasisPrepareResult,
} from './handyman-labor-pricing.service';

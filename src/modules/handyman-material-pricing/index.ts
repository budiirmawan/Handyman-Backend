/**
 * CR-HM-12 PART 03 — Handyman material pricing basis barrel.
 * Domain module ONLY: no controller, no routes, no HTTP, no OpenAPI.
 * BM fee rules are PART 04; the published read contract for
 * CR-HM-06/14/17 is PART 05. CR-HM-09 remains READ-ONLY truth and
 * CR-HM-06 snapshots are never re-priced here (§6).
 */

export {
  HANDYMAN_MATERIAL_PRICING_MODES,
  isHandymanMaterialPricingMode,
} from './handyman-material-pricing.types';
export type {
  HandymanMaterialPricingMode,
  HandymanMaterialPricingBasisRecord,
  NewHandymanMaterialPricingBasis,
  HandymanMaterialPricingLineInput,
  HandymanMaterialPricingLineBasis,
  HandymanMaterialPricingBasisEvaluation,
} from './handyman-material-pricing.types';

export {
  handymanMaterialPricingBasisNotFoundError,
  handymanMaterialPricingVersionNotDraftError,
  handymanMaterialPricingAlreadyDefinedError,
  handymanMaterialPricingKeyConflictError,
  handymanMaterialPricingBasisNotEffectiveError,
  handymanMaterialPricingCompositionError,
  handymanMaterialPricingValidationError,
} from './handyman-material-pricing.errors';

export {
  assertHandymanMaterialUnitAmount,
  evaluateHandymanMaterialPricingBasis,
} from './handyman-material-pricing.evaluate';

export { handymanMaterialPricingRepository }
  from './handyman-material-pricing.repository';

export {
  prepareHandymanMaterialPricingBasis,
  getHandymanMaterialPricingBasisForVersion,
  resolveHandymanMaterialPricingBasisAt,
  computeHandymanMaterialPricingBasisForScope,
} from './handyman-material-pricing.service';
export type {
  HandymanMaterialPricingBasisPrepareInput,
  HandymanMaterialPricingBasisPrepareResult,
  HandymanMaterialPricingBasisForScope,
} from './handyman-material-pricing.service';

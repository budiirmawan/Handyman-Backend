/**
 * CR-HM-12 PART 04 — Handyman BM fee rule barrel.
 * Domain module ONLY: no controller, no routes, no HTTP, no
 * OpenAPI. Definition + binding + fail-closed resolution surface
 * for CR-HM-14 consumption; NO entitlement math, NO settlement, NO
 * ledger, NO SaaS state (§7). The published read-contract wrap is
 * PART 05's; this module is not a second write path.
 */

export {
  HANDYMAN_BM_FEE_RULE_BASES,
  HANDYMAN_BM_FEE_RULE_MODES,
  isHandymanBmFeeRuleBasis,
  isHandymanBmFeeRuleMode,
} from './handyman-bm-fee-rule.types';
export type {
  HandymanBmFeeRuleBasis,
  HandymanBmFeeRuleMode,
  HandymanBmFeeRuleRecord,
  NewHandymanBmFeeRule,
} from './handyman-bm-fee-rule.types';

export {
  handymanBmFeeRuleNotFoundError,
  handymanBmFeeRuleVersionNotDraftError,
  handymanBmFeeRuleAlreadyDefinedError,
  handymanBmFeeRuleKeyConflictError,
  handymanBmFeeRuleNotEffectiveError,
  handymanBmFeeRuleValidationError,
} from './handyman-bm-fee-rule.errors';

export { handymanBmFeeRuleRepository }
  from './handyman-bm-fee-rule.repository';

export {
  prepareHandymanBmFeeRule,
  getHandymanBmFeeRuleForVersion,
  resolveHandymanBmFeeRuleAt,
} from './handyman-bm-fee-rule.service';
export type {
  HandymanBmFeeRulePrepareInput,
  HandymanBmFeeRulePrepareResult,
} from './handyman-bm-fee-rule.service';

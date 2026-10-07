/**
 * CR-HM-12 PART 04 — Handyman BM fee rule barrel.
 * Domain module ONLY: no controller, no routes, no HTTP, no
 * OpenAPI. Definition + binding + fail-closed resolution surface
 * for CR-HM-14 consumption; NO entitlement math, NO settlement, NO
 * ledger, NO SaaS state (§7). The published read-contract wrap is
 * PART 05's; this module is not a second write path.
 *
 * CR-HM-12 PART 06B adds the version-bound numeric TERM and the
 * explicit BENEFICIARY (`CR-HM-12_PART_06_BM_FEE_PREREQUISITE.md`
 * §4): DRAFT-window authored, append-only, exactly one per agreement
 * version, read-only for consumers. It publishes DATA ONLY — no fee
 * value is computed, applied, or stored anywhere in this barrel, and
 * the published PART 05 surface stays byte-compatible.
 */

export {
  HANDYMAN_BM_FEE_RULE_BASES,
  HANDYMAN_BM_FEE_RULE_MODES,
  HANDYMAN_BM_FEE_TERM_KINDS,
  HANDYMAN_BM_FEE_BENEFICIARY_KINDS,
  isHandymanBmFeeRuleBasis,
  isHandymanBmFeeRuleMode,
  isHandymanBmFeeTermKind,
  isHandymanBmFeeBeneficiaryKind,
} from './handyman-bm-fee-rule.types';
export type {
  HandymanBmFeeBeneficiaryKind,
  HandymanBmFeeBeneficiaryRecord,
  HandymanBmFeeRuleBasis,
  HandymanBmFeeRuleMode,
  HandymanBmFeeRuleRecord,
  HandymanBmFeeTermKind,
  HandymanBmFeeTermRecord,
  NewHandymanBmFeeBeneficiary,
  NewHandymanBmFeeRule,
  NewHandymanBmFeeTerm,
} from './handyman-bm-fee-rule.types';

export {
  handymanBmFeeBeneficiaryAlreadyDefinedError,
  handymanBmFeeBeneficiaryClientMismatchError,
  handymanBmFeeBeneficiaryKeyConflictError,
  handymanBmFeeBeneficiaryNotFoundError,
  handymanBmFeeBeneficiaryValidationError,
  handymanBmFeeBeneficiaryVersionNotDraftError,
  handymanBmFeeRuleNotFoundError,
  handymanBmFeeRuleVersionNotDraftError,
  handymanBmFeeRuleAlreadyDefinedError,
  handymanBmFeeRuleKeyConflictError,
  handymanBmFeeRuleNotEffectiveError,
  handymanBmFeeRuleValidationError,
  handymanBmFeeTermAlreadyDefinedError,
  handymanBmFeeTermKeyConflictError,
  handymanBmFeeTermNotFoundError,
  handymanBmFeeTermValidationError,
  handymanBmFeeTermVersionNotDraftError,
} from './handyman-bm-fee-rule.errors';

export {
  handymanBmFeePrerequisiteRepository,
  handymanBmFeeRuleRepository,
} from './handyman-bm-fee-rule.repository';

export {
  prepareHandymanBmFeeRule,
  getHandymanBmFeeRuleForVersion,
  resolveHandymanBmFeeRuleAt,
  prepareHandymanBmFeeTerm,
  prepareHandymanBmFeeBeneficiary,
  getHandymanBmFeeTermForVersion,
  getHandymanBmFeeBeneficiaryForVersion,
} from './handyman-bm-fee-rule.service';
export type {
  HandymanBmFeeBeneficiaryPrepareInput,
  HandymanBmFeeBeneficiaryPrepareResult,
  HandymanBmFeeRulePrepareInput,
  HandymanBmFeeRulePrepareResult,
  HandymanBmFeeTermPrepareInput,
  HandymanBmFeeTermPrepareResult,
} from './handyman-bm-fee-rule.service';

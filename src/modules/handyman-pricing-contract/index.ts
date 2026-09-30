/**
 * CR-HM-12 PART 05 — PUBLISHED PRICING/COMMERCIAL READ CONTRACT
 * barrel. Read-only composition ONLY: no controller, no routes, no
 * HTTP, no OpenAPI, no migration, no table, no mutation surface —
 * this module imports no database layer at all.
 *
 * Consumption law (FROZEN `CR-HM-12_START_GOVERNANCE.md` §10 row
 * 05, §6/§7, Handoff):
 * - CR-HM-06: may reference contract outputs for governed
 *   adjustments; approved quotation snapshots stay immutable and
 *   the F5 firewall is now PUBLISHED (lifted only in this
 *   read-direction sense — never a write path back).
 * - CR-HM-14: derives entitlements ONLY from DEFAULT-published
 *   rules (authoritativeForEntitlement) + governed transactions;
 *   zero SaaS state reads. PART 06B adds the ADDITIVE
 *   `readHandymanBmFeeConfigurationAt` (rule + version-bound numeric
 *   term + explicit beneficiary + `unconfiguredSlots`); the PART 05
 *   exports and their semantics are unchanged, and a missing slot is
 *   published as explicit `null` with a non-authoritative flag —
 *   never a default rate or payee.
 * - CR-HM-13: composes final charges from its own inputs; contract
 *   figures are basis facts, never ledger rows.
 * - CR-HM-17: presents bundle/evaluation views verbatim; zero
 *   client-side rule evaluation.
 */

export {
  HANDYMAN_PRICING_CONTRACT_BM_FEE_UNCONFIGURED_SLOTS,
  HANDYMAN_PRICING_CONTRACT_FACT_KIND,
  isHandymanPricingContractFactKind,
} from './handyman-pricing-contract.types';
export type {
  HandymanPricingContractFactKind,
  HandymanPricingContractBinding,
  HandymanPricingContractLaborBasisView,
  HandymanPricingContractMaterialBasisView,
  HandymanPricingContractBmFeeRuleView,
  HandymanPricingContract,
  HandymanPricingContractLaborEvaluation,
  HandymanPricingContractMaterialComposition,
  HandymanPricingContractBmFeeRuleConsumption,
  HandymanPricingContractBmFeeTermView,
  HandymanPricingContractBmFeeBeneficiaryView,
  HandymanPricingContractBmFeeConfiguration,
  HandymanPricingContractBmFeeUnconfiguredSlot,
} from './handyman-pricing-contract.types';

export {
  readHandymanPricingContractAt,
  readHandymanLaborPricingEvaluationAt,
  readHandymanMaterialPricingCompositionAt,
  readHandymanBmFeeRuleConsumptionAt,
  readHandymanBmFeeConfigurationAt,
} from './handyman-pricing-contract.service';

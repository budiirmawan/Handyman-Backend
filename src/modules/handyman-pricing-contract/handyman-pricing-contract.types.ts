/**
 * CR-HM-12 PART 05 — the PUBLISHED PRICING/COMMERCIAL READ CONTRACT
 * view types (FROZEN `CR-HM-12_START_GOVERNANCE.md` §10 PART 05,
 * §7, Handoff).
 *
 * These are the only shapes CR-HM-06 (governed adjustments /
 * commercial snapshots), CR-HM-13 (charge composition), CR-HM-14
 * (entitlement derivation) and CR-HM-17 (presentation) may consume
 * from CR-HM-12. Every view is READ-ONLY, version-exact (B6) and
 * labeled `CR_HM_12_BASIS_FACT`: a governed rule/basis fact, never
 * a final charge (§4.1, §6) and never a merged figure (§6/B10).
 * Zero SaaS/package facts exist here because none are even
 * reachable (§7). No vocabulary is redefined — consumers bind to
 * the PART 01–04 vocabularies themselves.
 */

import type {
  HandymanCommercialAgreementStatus,
} from '../handyman-commercial-agreements';
import type {
  HandymanBillableTimeBasis,
  HandymanCrewPricingMode,
  HandymanLaborPricingBasisResult,
  HandymanLaborPricingCurrency,
  HandymanLaborPricingMode,
} from '../handyman-labor-pricing';
import type {
  HandymanMaterialPricingBasisForScope,
  HandymanMaterialPricingMode,
} from '../handyman-material-pricing';
import type {
  HandymanBmFeeRuleBasis,
  HandymanBmFeeRuleMode,
} from '../handyman-bm-fee-rules';

/** Discriminant labeling every published figure as a governed
 * rule/basis fact — never a charge, ledger row, or payment. */
export const HANDYMAN_PRICING_CONTRACT_FACT_KIND =
  'CR_HM_12_BASIS_FACT' as const;

export type HandymanPricingContractFactKind =
  typeof HANDYMAN_PRICING_CONTRACT_FACT_KIND;

export function isHandymanPricingContractFactKind(
  value: unknown,
): value is HandymanPricingContractFactKind {
  return value === HANDYMAN_PRICING_CONTRACT_FACT_KIND;
}

/**
 * The exact-version anchor of one contract read: which agreement
 * version answered, for which client, at which instant. Consumers
 * must persist these ids with any derived fact (B6 binding law);
 * "latest" is never resolvable through this contract.
 */
export type HandymanPricingContractBinding = {
  clientId: string;
  agreementId: string;
  agreementVersionId: string;
  versionNumber: number;
  status: HandymanCommercialAgreementStatus;
  requestedAsOfUtc: string;
  effectiveFromUtc: string | null;
  effectiveToUtc: string | null;
  factKind: HandymanPricingContractFactKind;
};

/** One frozen LABOR rule of the exact version (§6: LABOR side of
 * the structural separation). unitAmount is a governed rule fact
 * (§4.2), never a customer-approved charge. */
export type HandymanPricingContractLaborBasisView = {
  basisRowId: string;
  agreementVersionId: string;
  mode: HandymanLaborPricingMode;
  crewMode: HandymanCrewPricingMode;
  billableTimeBasis: HandymanBillableTimeBasis | null;
  unitAmount: string;
  currency: HandymanLaborPricingCurrency;
  factKind: HandymanPricingContractFactKind;
  isFinalCharge: false;
};

/** The exact version's single MATERIAL basis definition (quantify-
 * how only — amounts live in the CR-HM-06 snapshot, quantities in
 * CR-HM-09; PART 03 law). */
export type HandymanPricingContractMaterialBasisView = {
  basisRowId: string;
  agreementVersionId: string;
  mode: HandymanMaterialPricingMode;
  factKind: HandymanPricingContractFactKind;
  isFinalCharge: false;
};

/**
 * The exact version's BM fee rule (§7). `mode` is the frozen
 * DEFAULT/REFERENCE vocabulary from PART 04;
 * `authoritativeForEntitlement` is the machine-visible
 * "reference ≠ final" firewall: ONLY a DEFAULT rule may feed
 * CR-HM-14 entitlement derivation — a REFERENCE rule must never be
 * treated as final. The fee VALUE is never present here (derivation
 * is CR-HM-14's).
 */
export type HandymanPricingContractBmFeeRuleView = {
  ruleRowId: string;
  agreementVersionId: string;
  basis: HandymanBmFeeRuleBasis;
  mode: HandymanBmFeeRuleMode;
  authoritativeForEntitlement: boolean;
  factKind: HandymanPricingContractFactKind;
};

/**
 * The per-version contract bundle: agreement anchor + all three
 * frozen rule sets. LABOR and MATERIAL are SEPARATE fields and are
 * never summed here (§6/B10; combined totals are CR-HM-13 ledger
 * composition). `null` means the version explicitly defines nothing
 * for that slot — never a silent default (§4.5).
 */
export type HandymanPricingContract = {
  binding: HandymanPricingContractBinding;
  laborBasis: HandymanPricingContractLaborBasisView[];
  materialBasis: HandymanPricingContractMaterialBasisView | null;
  bmFeeRule: HandymanPricingContractBmFeeRuleView | null;
};

/** Rule application over governed transaction inputs (PART 02's
 * pure evaluator, version-anchored). The evaluated amount is a
 * basis fact for CR-HM-13/14 consumption — posting a charge is
 * neither here nor anywhere in CR-HM-12. */
export type HandymanPricingContractLaborEvaluation = {
  binding: HandymanPricingContractBinding;
  basisRowId: string;
  evaluation: HandymanLaborPricingBasisResult;
  factKind: HandymanPricingContractFactKind;
  isFinalCharge: false;
};

/** PART 03's READ-ONLY scope composition (settled quantities ×
 * snapshot unit amounts), wrapped with the version anchor. Never a
 * final charge; never merged with LABOR (§6). */
export type HandymanPricingContractMaterialComposition = {
  binding: HandymanPricingContractBinding;
  executionScopeId: string;
  composition: HandymanMaterialPricingBasisForScope;
  factKind: HandymanPricingContractFactKind;
  isFinalCharge: false;
  mergedWithLabor: false;
};

/** The fail-closed rule read CR-HM-14 consumes for entitlement
 * derivation (§7). Absent rule = bounded conflict at the resolver;
 * a REFERENCE rule arrives flagged non-authoritative. */
export type HandymanPricingContractBmFeeRuleConsumption = {
  binding: HandymanPricingContractBinding;
  rule: HandymanPricingContractBmFeeRuleView;
};

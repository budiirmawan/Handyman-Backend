import { isValidUuid } from '../clients';
import {
  handymanCommercialAgreementValidationError,
  parseHandymanAgreementTimestamp,
  resolveHandymanCommercialAgreementAt,
  type HandymanCommercialAgreementVersionRecord,
} from '../handyman-commercial-agreements';
import {
  evaluateHandymanLaborPricingBasis,
  listHandymanLaborPricingBasisForVersion,
  resolveHandymanLaborPricingBasisAt,
  type HandymanLaborPricingBasisRecord,
  type HandymanLaborPricingExecuteInput,
} from '../handyman-labor-pricing';
import {
  computeHandymanMaterialPricingBasisForScope,
  getHandymanMaterialPricingBasisForVersion,
  type HandymanMaterialPricingBasisRecord,
} from '../handyman-material-pricing';
import {
  getHandymanBmFeeRuleForVersion,
  resolveHandymanBmFeeRuleAt,
  type HandymanBmFeeRuleRecord,
} from '../handyman-bm-fee-rules';
import {
  HANDYMAN_PRICING_CONTRACT_FACT_KIND,
  type HandymanPricingContract,
  type HandymanPricingContractBinding,
  type HandymanPricingContractBmFeeRuleConsumption,
  type HandymanPricingContractBmFeeRuleView,
  type HandymanPricingContractLaborBasisView,
  type HandymanPricingContractLaborEvaluation,
  type HandymanPricingContractMaterialBasisView,
  type HandymanPricingContractMaterialComposition,
} from './handyman-pricing-contract.types';

/**
 * CR-HM-12 PART 05 — the PUBLISHED PRICING/COMMERCIAL READ
 * CONTRACT for CR-HM-06/13/14/17 consumption (FROZEN
 * `CR-HM-12_START_GOVERNANCE.md` §10 PART 05, §6/§7, Handoff).
 *
 * READ-ONLY COMPOSITION ONLY. This module owns NO table, NO
 * mutation, NO vocabulary, NO authority: every fact here is
 * produced by the PART 01–04 resolvers/evaluators and merely
 * bundled, version-anchored and firewall-labeled. It is not a
 * second write path — it does not import a database access layer
 * AT ALL, so it is structurally incapable of executing SQL or
 * writing rows. The fail-closed posture is inherited unchanged
 * from the PART 01 anchor: exact effective version or bounded
 * error, never "latest", never a silent default (§4.5).
 *
 * Published firewalls, enforced by construction and constants:
 * - reference ≠ final: a REFERENCE BM fee rule is exposed with
 *   `authoritativeForEntitlement: false`; DEFAULT-only consumers
 *   (CR-HM-14 entitlement) must gate on it (§7).
 * - no final charges: every figure carries `isFinalCharge: false`
 *   and `factKind: 'CR_HM_12_BASIS_FACT'`; charge/ledger/posting
 *   authority remains CR-HM-13 (§10 row 05, Handoff).
 * - bases never merge: LABOR and MATERIAL are separate fields; no
 *   combined total exists here (§6/B10).
 * - no SaaS computation: no SaaS import is even present, so no
 *   package/subscription state can enter any number here (§7).
 */

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanCommercialAgreementValidationError(field);
  }
  return raw;
}

function toIsoUtc(value: Date | null): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function buildBinding(
  version: HandymanCommercialAgreementVersionRecord,
  asOfUtc: Date,
): HandymanPricingContractBinding {
  return {
    clientId: version.clientId,
    agreementId: version.agreementId,
    agreementVersionId: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    requestedAsOfUtc: asOfUtc.toISOString(),
    effectiveFromUtc: toIsoUtc(version.effectiveFrom),
    effectiveToUtc: toIsoUtc(version.effectiveTo),
    factKind: HANDYMAN_PRICING_CONTRACT_FACT_KIND,
  };
}

/** B6 integrity guard: a fact bound to any version other than the
 * resolved anchor is a bounded contract failure, never a silent
 * mix across versions. */
function assertBoundToVersion(
  row: { agreementVersionId: string },
  version: HandymanCommercialAgreementVersionRecord,
): void {
  if (row.agreementVersionId !== version.id) {
    throw handymanCommercialAgreementValidationError('rowSetBinding');
  }
}

function laborView(
  basis: HandymanLaborPricingBasisRecord,
): HandymanPricingContractLaborBasisView {
  return {
    basisRowId: basis.id,
    agreementVersionId: basis.agreementVersionId,
    mode: basis.mode,
    crewMode: basis.crewMode,
    billableTimeBasis: basis.billableTimeBasis,
    unitAmount: basis.unitAmount,
    currency: basis.currency,
    factKind: HANDYMAN_PRICING_CONTRACT_FACT_KIND,
    isFinalCharge: false,
  };
}

function materialView(
  basis: HandymanMaterialPricingBasisRecord,
): HandymanPricingContractMaterialBasisView {
  return {
    basisRowId: basis.id,
    agreementVersionId: basis.agreementVersionId,
    mode: basis.mode,
    factKind: HANDYMAN_PRICING_CONTRACT_FACT_KIND,
    isFinalCharge: false,
  };
}

function bmFeeRuleView(
  rule: HandymanBmFeeRuleRecord,
): HandymanPricingContractBmFeeRuleView {
  return {
    ruleRowId: rule.id,
    agreementVersionId: rule.agreementVersionId,
    basis: rule.basis,
    mode: rule.mode,
    // Frozen §7 firewall: ONLY the version's DEFAULT rule may feed
    // entitlement derivation. A REFERENCE rule is never final.
    authoritativeForEntitlement: rule.mode === 'DEFAULT',
    factKind: HANDYMAN_PRICING_CONTRACT_FACT_KIND,
  };
}

/**
 * The per-version contract bundle. The PART 01 resolver is the sole
 * authority for WHICH version answers (fail-closed as-of anchor);
 * the version's three frozen rule sets are then read exactly off
 * that version id. Explicit `null` slots mean "this version defines
 * nothing" — consumers must not substitute a default (§4.5).
 */
export async function readHandymanPricingContractAt(
  clientId: string,
  asOf: string,
): Promise<HandymanPricingContract> {
  const client = ensureUuid(clientId, 'clientId');
  const instant = parseHandymanAgreementTimestamp(asOf, 'asOf');
  const version = await resolveHandymanCommercialAgreementAt(
    client,
    instant.toISOString(),
  );

  const [laborRows, materialRow, rule] = await Promise.all([
    listHandymanLaborPricingBasisForVersion(version.id),
    getHandymanMaterialPricingBasisForVersion(version.id),
    getHandymanBmFeeRuleForVersion(version.id),
  ]);

  for (const row of laborRows) {
    assertBoundToVersion(row, version);
  }
  if (materialRow) {
    assertBoundToVersion(materialRow, version);
  }
  if (rule) {
    assertBoundToVersion(rule, version);
  }

  // Deterministic bundle order: mode, then crew mode.
  const ordered = [...laborRows].sort((a, b) =>
    a.mode === b.mode
      ? a.crewMode.localeCompare(b.crewMode)
      : a.mode.localeCompare(b.mode),
  );

  return {
    binding: buildBinding(version, instant),
    laborBasis: ordered.map(laborView),
    materialBasis: materialRow ? materialView(materialRow) : null,
    bmFeeRule: rule ? bmFeeRuleView(rule) : null,
  };
}

/**
 * Rule application published for CR-HM-13's charge preparation and
 * CR-HM-17's previews: the exact-version LABOR basis for one
 * published mode, evaluated purely over governed transaction
 * inputs. Fail-closed on a missing definition (never a silent
 * default); the evaluated amount is a BASIS FACT for the caller's
 * own authority — posting stays CR-HM-13's (§10 row 05, §4.1).
 */
export async function readHandymanLaborPricingEvaluationAt(
  clientId: string,
  asOf: string,
  mode: string,
  input: HandymanLaborPricingExecuteInput,
): Promise<HandymanPricingContractLaborEvaluation> {
  const client = ensureUuid(clientId, 'clientId');
  const instant = parseHandymanAgreementTimestamp(asOf, 'asOf');
  const [version, basis] = await Promise.all([
    resolveHandymanCommercialAgreementAt(client, instant.toISOString()),
    resolveHandymanLaborPricingBasisAt(client, instant.toISOString(), mode),
  ]);
  assertBoundToVersion(basis, version);
  return {
    binding: buildBinding(version, instant),
    basisRowId: basis.id,
    evaluation: evaluateHandymanLaborPricingBasis(basis, input),
    factKind: HANDYMAN_PRICING_CONTRACT_FACT_KIND,
    isFinalCharge: false,
  };
}

/**
 * The published MATERIAL basis read for one scope: PART 03's
 * READ-ONLY composition (CR-HM-09 settled quantities × CR-HM-06
 * approved snapshot amounts). The caller passes its client + the
 * scope; the contract cross-checks that the scope's as-of version
 * IS the version resolved for that client — a foreign or
 * misaligned scope is a bounded failure, never a borrowed fact.
 * Never a final charge; never merged with LABOR (§6/B10).
 */
export async function readHandymanMaterialPricingCompositionAt(
  clientId: string,
  executionScopeId: string,
  asOf: string,
  actorUserId: string,
): Promise<HandymanPricingContractMaterialComposition> {
  const client = ensureUuid(clientId, 'clientId');
  const scopeId = ensureUuid(executionScopeId, 'executionScopeId');
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const instant = parseHandymanAgreementTimestamp(asOf, 'asOf');

  const [version, composition] = await Promise.all([
    resolveHandymanCommercialAgreementAt(client, instant.toISOString()),
    computeHandymanMaterialPricingBasisForScope(
      scopeId,
      instant.toISOString(),
      actor,
    ),
  ]);

  // Published firewall (§5 binding): the scope's own as-of version
  // must be the exact version resolved for this client.
  if (composition.agreementVersionId !== version.id) {
    throw handymanCommercialAgreementValidationError('scopeVersionBinding');
  }

  return {
    binding: buildBinding(version, instant),
    executionScopeId: composition.executionScopeId,
    composition,
    factKind: HANDYMAN_PRICING_CONTRACT_FACT_KIND,
    isFinalCharge: false,
    mergedWithLabor: false,
  };
}

/**
 * THE published rule read CR-HM-14 consumes for BM fee entitlement
 * derivation (§7 "Publishing the rule contract CR-HM-14 consumes"
 * — and nothing more). Fail-closed exactly like PART 04: no rule on
 * the effective version is a bounded conflict, never another
 * version's rule; REFERENCE rules arrive explicitly flagged
 * non-authoritative. The fee VALUE and any entitlement math remain
 * CR-HM-14's — there is no amount field in this contract to
 * misuse.
 */
export async function readHandymanBmFeeRuleConsumptionAt(
  clientId: string,
  asOf: string,
): Promise<HandymanPricingContractBmFeeRuleConsumption> {
  const client = ensureUuid(clientId, 'clientId');
  const instant = parseHandymanAgreementTimestamp(asOf, 'asOf');
  const [version, rule] = await Promise.all([
    resolveHandymanCommercialAgreementAt(client, instant.toISOString()),
    resolveHandymanBmFeeRuleAt(client, instant.toISOString()),
  ]);
  assertBoundToVersion(rule, version);
  return {
    binding: buildBinding(version, instant),
    rule: bmFeeRuleView(rule),
  };
}

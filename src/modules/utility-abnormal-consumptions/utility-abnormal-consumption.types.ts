import type { FindingAction, PublicFinding } from '../findings';
import type { UtilityType } from '../utility-meters/utility-meter.types';

/**
 * BE-18J — Abnormal Consumption domain types.
 *
 * Detection compares an authoritative BE-18G consumption against a
 * configurable rule, using the BE-18H chronological history as the baseline
 * where a rule needs one. Nothing upstream is mutated.
 *
 * Each rule is one arithmetic comparison whose numbers live in data — there
 * is no model, no scoring, no seasonality, and deliberately no generic
 * anomaly framework.
 *
 * Operational follow-up is BE-09's: an abnormality may reference a Finding,
 * but Finding workflow, status, assignment and available actions all remain
 * BE-09's authority and are never re-derived here.
 *
 * Out of scope, deliberately: Verification (BE-18K), tariffs and billing.
 */

export const UTILITY_ABNORMALITY_TYPES = [
  'HIGH_USAGE',
  'LOW_USAGE',
  'ZERO_USAGE',
  'NEGATIVE_OR_INVALID',
  'SUDDEN_CHANGE',
] as const;

export type UtilityAbnormalityType =
  (typeof UTILITY_ABNORMALITY_TYPES)[number];

export function isUtilityAbnormalityType(
  value: unknown,
): value is UtilityAbnormalityType {
  return (
    typeof value === 'string' &&
    (UTILITY_ABNORMALITY_TYPES as readonly string[]).includes(value)
  );
}

/**
 * How a threshold is read.
 *
 *   ABSOLUTE            — compare the consumption value to the threshold.
 *   PERCENT_OF_BASELINE — compare it to the baseline average, as a percentage.
 */
export const UTILITY_ABNORMALITY_COMPARISON_MODES = [
  'ABSOLUTE',
  'PERCENT_OF_BASELINE',
] as const;

export type UtilityAbnormalityComparisonMode =
  (typeof UTILITY_ABNORMALITY_COMPARISON_MODES)[number];

export function isUtilityAbnormalityComparisonMode(
  value: unknown,
): value is UtilityAbnormalityComparisonMode {
  return (
    typeof value === 'string' &&
    (UTILITY_ABNORMALITY_COMPARISON_MODES as readonly string[]).includes(value)
  );
}

export const UTILITY_ABNORMALITY_RULE_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type UtilityAbnormalityRuleStatus =
  (typeof UTILITY_ABNORMALITY_RULE_STATUSES)[number];

export function isUtilityAbnormalityRuleStatus(
  value: unknown,
): value is UtilityAbnormalityRuleStatus {
  return (
    typeof value === 'string' &&
    (UTILITY_ABNORMALITY_RULE_STATUSES as readonly string[]).includes(value)
  );
}

/** OPEN → RESOLVED / DISMISSED. Both closures are terminal. */
export const UTILITY_ABNORMAL_CONSUMPTION_STATUSES = [
  'OPEN',
  'RESOLVED',
  'DISMISSED',
] as const;

export type UtilityAbnormalConsumptionStatus =
  (typeof UTILITY_ABNORMAL_CONSUMPTION_STATUSES)[number];

export function isUtilityAbnormalConsumptionStatus(
  value: unknown,
): value is UtilityAbnormalConsumptionStatus {
  return (
    typeof value === 'string' &&
    (UTILITY_ABNORMAL_CONSUMPTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Backend-authoritative actions on an abnormality record. The frontend never
 * derives these — mirroring the BE-09 `availableActions` convention.
 */
export const UTILITY_ABNORMAL_CONSUMPTION_ACTIONS = [
  'RESOLVE',
  'DISMISS',
  'LINK_FINDING',
] as const;

export type UtilityAbnormalConsumptionAction =
  (typeof UTILITY_ABNORMAL_CONSUMPTION_ACTIONS)[number];

/* -------------------------------------------------------------------------
 * Detection rule
 * ---------------------------------------------------------------------- */

/** Full rule record. */
export type UtilityAbnormalityRuleRecord = {
  id: string;
  clientId: string;
  utilityType: UtilityType;
  abnormalityType: UtilityAbnormalityType;
  name: string;
  description: string | null;
  /** Raw NUMERIC string from PostgreSQL so no precision is lost in transit. */
  thresholdValue: string | null;
  comparisonMode: UtilityAbnormalityComparisonMode;
  baselineWindow: number;
  status: UtilityAbnormalityRuleStatus;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation of a rule. */
export type PublicUtilityAbnormalityRule = {
  id: string;
  clientId: string;
  utilityType: UtilityType;
  abnormalityType: UtilityAbnormalityType;
  name: string;
  description: string | null;
  thresholdValue: number | null;
  comparisonMode: UtilityAbnormalityComparisonMode;
  baselineWindow: number;
  status: UtilityAbnormalityRuleStatus;
  createdAt: string;
  updatedAt: string;
};

/** POST /clients/:clientId/utility-abnormality-rules */
export type CreateUtilityAbnormalityRuleInput = {
  clientId: string;
  utilityType: UtilityType;
  abnormalityType: UtilityAbnormalityType;
  name: string;
  description?: string | null;
  thresholdValue?: number | null;
  comparisonMode?: UtilityAbnormalityComparisonMode;
  baselineWindow?: number;
  status?: UtilityAbnormalityRuleStatus;
};

/** Fully-resolved rule ready for persistence. */
export type NewUtilityAbnormalityRule = {
  clientId: string;
  utilityType: UtilityType;
  abnormalityType: UtilityAbnormalityType;
  name: string;
  description: string | null;
  thresholdValue: number | null;
  comparisonMode: UtilityAbnormalityComparisonMode;
  baselineWindow: number;
  status: UtilityAbnormalityRuleStatus;
};

/** Filters for the client-scoped rule list. */
export type UtilityAbnormalityRuleFilters = {
  utilityType?: UtilityType;
  abnormalityType?: UtilityAbnormalityType;
  status?: UtilityAbnormalityRuleStatus;
};

/* -------------------------------------------------------------------------
 * Abnormal consumption record
 * ---------------------------------------------------------------------- */

/** Full abnormality record. */
export type UtilityAbnormalConsumptionRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  utilityType: UtilityType;
  consumptionId: string;
  ruleId: string | null;
  abnormalityType: UtilityAbnormalityType;
  comparisonMode: UtilityAbnormalityComparisonMode;
  /** Raw NUMERIC strings from PostgreSQL so no precision is lost in transit. */
  detectedValue: string;
  referenceValue: string | null;
  thresholdValue: string | null;
  uomId: string;
  periodStart: Date;
  periodEnd: Date;
  detectedAt: Date;
  detectedByUserId: string | null;
  status: UtilityAbnormalConsumptionStatus;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  resolutionNotes: string | null;
  findingId: string | null;
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Identifying Meter context denormalised into a response. */
export type AbnormalityMeterSummary = {
  id: string;
  code: string;
  name: string;
  utilityType: UtilityType;
  uomId: string;
  buildingId: string;
  status: string;
};

/** Resolved BE-07 UOM context. */
export type AbnormalityUomSummary = {
  id: string;
  code: string;
  name: string;
  symbol: string;
};

/**
 * Read-through view of the source consumption. Resolved from BE-18G at query
 * time so the abnormality row never becomes a second source of truth for it.
 */
export type AbnormalityConsumptionSummary = {
  id: string;
  consumptionValue: number;
  uomId: string;
  periodStart: string;
  periodEnd: string;
  meterId: string;
  tenantCompanyId: string | null;
};

/** Safe public representation exposed through the API. */
export type PublicUtilityAbnormalConsumption = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  utilityType: UtilityType;
  consumptionId: string;
  ruleId: string | null;
  abnormalityType: UtilityAbnormalityType;
  comparisonMode: UtilityAbnormalityComparisonMode;
  detectedValue: number;
  referenceValue: number | null;
  thresholdValue: number | null;
  uomId: string;
  periodStart: string;
  periodEnd: string;
  detectedAt: string;
  detectedByUserId: string | null;
  status: UtilityAbnormalConsumptionStatus;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  resolutionNotes: string | null;
  /** BE-09 Finding reference; the Finding itself stays BE-09's. */
  findingId: string | null;
  /** BE-18D tenant context as it stood across the period. */
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  /** Backend-authoritative — never derived by the client. */
  availableActions: UtilityAbnormalConsumptionAction[];
  meter?: AbnormalityMeterSummary | null;
  uom?: AbnormalityUomSummary | null;
  consumption?: AbnormalityConsumptionSummary | null;
  rule?: PublicUtilityAbnormalityRule | null;
  /** The authoritative BE-09 Finding, when one is linked. */
  finding?: PublicFinding | null;
  /** BE-09 backend-authoritative finding actions (never re-derived). */
  findingAvailableActions?: FindingAction[];
};

/** Input accepted by POST /utility/consumptions/:id/abnormality-evaluations. */
export type EvaluateConsumptionInput = {
  consumptionId: string;
  detectedByUserId?: string;
  notes?: string | null;
};

/** The outcome of evaluating one consumption against every active rule. */
export type UtilityAbnormalityEvaluation = {
  consumptionId: string;
  meterId: string;
  /** The consumption value the rules were applied to. */
  evaluatedValue: number;
  /** Mean of the prior periods used as a baseline, when one was available. */
  baselineValue: number | null;
  baselinePeriods: number;
  /** True when no active rule flagged the consumption. */
  normal: boolean;
  rulesEvaluated: number;
  detections: PublicUtilityAbnormalConsumption[];
};

/** Fully-resolved detection ready for persistence. */
export type NewUtilityAbnormalConsumption = {
  clientId: string;
  buildingId: string;
  meterId: string;
  utilityType: UtilityType;
  consumptionId: string;
  ruleId: string | null;
  abnormalityType: UtilityAbnormalityType;
  comparisonMode: UtilityAbnormalityComparisonMode;
  detectedValue: number;
  referenceValue: number | null;
  thresholdValue: number | null;
  uomId: string;
  periodStart: Date;
  periodEnd: Date;
  detectedByUserId: string | null;
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
};

/** PATCH-equivalent input for closing a flag. */
export type ResolveUtilityAbnormalConsumptionInput = {
  abnormalConsumptionId: string;
  status: 'RESOLVED' | 'DISMISSED';
  resolutionNotes?: string | null;
};

/** POST /utility/abnormal-consumptions/:id/finding */
export type LinkAbnormalConsumptionFindingInput = {
  abnormalConsumptionId: string;
  /** Link an existing BE-09 Finding instead of creating one. */
  findingId?: string;
  /** Create mode — BE-09 creates and owns the Finding. */
  title?: string;
  description?: string | null;
};

/** Filters shared by the abnormality list endpoints. */
export type UtilityAbnormalConsumptionFilters = {
  meterId?: string;
  tenantCompanyId?: string;
  buildingId?: string;
  status?: UtilityAbnormalConsumptionStatus;
  abnormalityType?: UtilityAbnormalityType;
  utilityType?: UtilityType;
  /** Inclusive bounds applied to the abnormality period. */
  from?: Date;
  to?: Date;
  limit?: number;
};

/** Scope anchor for a list query — always one authoritative column. */
export type UtilityAbnormalConsumptionScope = {
  column: 'meter_id' | 'building_id' | 'tenant_company_id' | 'client_id';
  value: string;
};

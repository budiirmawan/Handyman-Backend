/**
 * CR-BE-ESG-01 PART 03 — ESG Metric Values & Periods domain types.
 *
 * Building-scoped periodized ESG values (0328). Client ownership derived via
 * Building, never from caller. Governed metric_definition_id composite FK.
 *
 * This module owns metric values only. It does NOT own automatic utility/waste
 * aggregation (PART 05), baselines/targets (PART 04), verification workflow,
 * evidence bindings, KPI/reporting, recycling-rate, IKE/IKA, emission factors,
 * carbon conversion, certification, scheduler, or backfill.
 */

export const ESG_PERIOD_TYPES = ['DAILY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const;
export type EsgPeriodType = (typeof ESG_PERIOD_TYPES)[number];

export function isEsgPeriodType(v: unknown): v is EsgPeriodType {
  return typeof v === 'string' && (ESG_PERIOD_TYPES as readonly string[]).includes(v);
}

export const ESG_CALCULATION_METHODS = ['CALCULATED', 'MANUAL', 'HYBRID'] as const;
export type EsgCalculationMethod = (typeof ESG_CALCULATION_METHODS)[number];

export function isEsgCalculationMethod(v: unknown): v is EsgCalculationMethod {
  return typeof v === 'string' && (ESG_CALCULATION_METHODS as readonly string[]).includes(v);
}

export const ESG_SOURCE_TYPES = [
  'UTILITY_CONSUMPTION',
  'WASTE_RECORD',
  'MANUAL_ENTRY',
  'IMPORT',
  'SYSTEM',
] as const;
export type EsgSourceType = (typeof ESG_SOURCE_TYPES)[number];

export function isEsgSourceType(v: unknown): v is EsgSourceType {
  return typeof v === 'string' && (ESG_SOURCE_TYPES as readonly string[]).includes(v);
}

export const ESG_DATA_QUALITIES = ['ACTUAL', 'ESTIMATED', 'MISSING'] as const;
export type EsgDataQuality = (typeof ESG_DATA_QUALITIES)[number];

export function isEsgDataQuality(v: unknown): v is EsgDataQuality {
  return typeof v === 'string' && (ESG_DATA_QUALITIES as readonly string[]).includes(v);
}

export const ESG_VERIFICATION_STATUSES = [
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'NOT_REQUIRED',
] as const;
export type EsgVerificationStatus = (typeof ESG_VERIFICATION_STATUSES)[number];

export function isEsgVerificationStatus(v: unknown): v is EsgVerificationStatus {
  return typeof v === 'string' && (ESG_VERIFICATION_STATUSES as readonly string[]).includes(v);
}

export type EsgMetricValueRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  metricDefinitionId: string;
  periodType: EsgPeriodType;
  periodStart: Date;
  periodEnd: Date;
  value: string | null; // NUMERIC string or null when MISSING
  uomId: string;
  calculationMethod: EsgCalculationMethod;
  sourceType: EsgSourceType;
  sourceRefs: unknown; // JSONB
  dataQuality: EsgDataQuality;
  verificationStatus: EsgVerificationStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicEsgMetricValue = {
  id: string;
  clientId: string;
  buildingId: string;
  metricDefinitionId: string;
  periodType: EsgPeriodType;
  periodStart: string;
  periodEnd: string;
  value: number | null;
  uomId: string;
  calculationMethod: EsgCalculationMethod;
  sourceType: EsgSourceType;
  sourceRefs: string[] | null;
  dataQuality: EsgDataQuality;
  verificationStatus: EsgVerificationStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateEsgMetricValueInput = {
  buildingId: string;
  metricDefinitionId: string;
  periodType: EsgPeriodType;
  periodStart: string; // ISO
  periodEnd: string; // ISO
  value?: number | null;
  uomId: string;
  calculationMethod: EsgCalculationMethod;
  sourceType: EsgSourceType;
  sourceRefs?: string[] | null;
  dataQuality?: EsgDataQuality;
  verificationStatus?: EsgVerificationStatus;
};

export type NewEsgMetricValue = {
  clientId: string;
  buildingId: string;
  metricDefinitionId: string;
  periodType: EsgPeriodType;
  periodStart: Date;
  periodEnd: Date;
  value: number | null;
  uomId: string;
  calculationMethod: EsgCalculationMethod;
  sourceType: EsgSourceType;
  sourceRefs: string[] | null;
  dataQuality: EsgDataQuality;
  verificationStatus: EsgVerificationStatus;
  createdByUserId: string;
};

export type UpdateEsgMetricValueInput = {
  value?: number | null;
  uomId?: string;
  calculationMethod?: EsgCalculationMethod;
  sourceType?: EsgSourceType;
  sourceRefs?: string[] | null;
  dataQuality?: EsgDataQuality;
  verificationStatus?: EsgVerificationStatus;
};

export type EsgMetricValueFilters = {
  clientId?: string;
  buildingId?: string;
  metricDefinitionId?: string;
  periodType?: EsgPeriodType;
  calculationMethod?: EsgCalculationMethod;
  sourceType?: EsgSourceType;
  dataQuality?: EsgDataQuality;
  verificationStatus?: EsgVerificationStatus;
  uomId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
};

/**
 * Bounded source read for actor-scoped ESG metric trend consumers.
 *
 * Building scope is supplied as a set and intersected with the authenticated
 * user's governed Building scope by the service. Persisted periods are read
 * using containment semantics: a value is included only when its complete
 * [periodStart, periodEnd] lies within the requested bounds.
 */
export type EsgMetricValueReadRequest = {
  buildingIds: readonly string[];
  metricDefinitionIds?: readonly string[];
  periodStart: string;
  periodEnd: string;
};

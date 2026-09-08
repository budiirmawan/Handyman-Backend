import type { UtilityType } from '../utility-meters/utility-meter.types';

/**
 * BE-18M — Utility Aggregation domain types.
 *
 * A read-only summary over authoritative BE-18 records. This module owns no
 * table: every figure is computed by query from BE-18G consumptions, BE-18J
 * abnormalities, BE-18K verifications and BE-18L approvals at request time.
 * Nothing is materialised, so an aggregate can never drift from the records
 * it summarises — deliberately not a BI or reporting warehouse.
 *
 * Meter Reading (BE-18E) and Consumption (BE-18G) rows are never copied or
 * re-derived; they are only summed.
 *
 * Out of scope, deliberately: tariffs, cost, billing, invoicing and
 * accounting. Money never lives in BE-18M.
 */

/**
 * How Main / Sub Meter hierarchy is handled when totalling.
 *
 *   EXCLUDE_SUB_METERS — the default. A Sub Meter's usage is physically
 *     already contained in its Main Meter's reading, so counting both would
 *     double-count the same energy. Only Meters that are not an ACTIVE Sub
 *     Meter of another Meter contribute to totals.
 *   ALL_METERS — every Meter contributes. Useful for reconciling a Main
 *     against its Subs, but the total is knowingly inclusive of overlap.
 */
export const UTILITY_AGGREGATION_METER_SCOPES = [
  'EXCLUDE_SUB_METERS',
  'ALL_METERS',
] as const;

export type UtilityAggregationMeterScope =
  (typeof UTILITY_AGGREGATION_METER_SCOPES)[number];

export function isUtilityAggregationMeterScope(
  value: unknown,
): value is UtilityAggregationMeterScope {
  return (
    typeof value === 'string' &&
    (UTILITY_AGGREGATION_METER_SCOPES as readonly string[]).includes(value)
  );
}

/** How the aggregate is broken down. */
export const UTILITY_AGGREGATION_GROUPINGS = [
  'UTILITY_TYPE',
  'METER',
  'BUILDING',
  'TENANT',
  'PERIOD',
] as const;

export type UtilityAggregationGrouping =
  (typeof UTILITY_AGGREGATION_GROUPINGS)[number];

export function isUtilityAggregationGrouping(
  value: unknown,
): value is UtilityAggregationGrouping {
  return (
    typeof value === 'string' &&
    (UTILITY_AGGREGATION_GROUPINGS as readonly string[]).includes(value)
  );
}

/** Calendar bucket used by the PERIOD grouping. */
export const UTILITY_AGGREGATION_INTERVALS = ['DAY', 'MONTH', 'YEAR'] as const;

export type UtilityAggregationInterval =
  (typeof UTILITY_AGGREGATION_INTERVALS)[number];

export function isUtilityAggregationInterval(
  value: unknown,
): value is UtilityAggregationInterval {
  return (
    typeof value === 'string' &&
    (UTILITY_AGGREGATION_INTERVALS as readonly string[]).includes(value)
  );
}

/**
 * Query scope. Exactly one anchor (client, building, meter or tenant) is
 * always applied, so an aggregate can never span Clients or reach a Building
 * the actor cannot access.
 */
export type UtilityAggregationScope = {
  clientId?: string;
  buildingId?: string;
  meterId?: string;
  tenantCompanyId?: string;
};

/** Filters narrowing an aggregation. */
export type UtilityAggregationFilters = {
  utilityType?: UtilityType;
  /** Inclusive bounds applied to the consumption period. */
  from?: Date;
  to?: Date;
  meterScope?: UtilityAggregationMeterScope;
  interval?: UtilityAggregationInterval;
};

/** Consumption totals for one bucket. */
export type UtilityConsumptionTotals = {
  /** Number of BE-18G consumption records summed. */
  consumptionCount: number;
  /** Sum of `consumption_value` across those records. */
  totalConsumption: number;
  /** Distinct Meters contributing to this bucket. */
  meterCount: number;
  periodStart: string | null;
  periodEnd: string | null;
};

/** One row of a grouped aggregation. */
export type UtilityAggregationBucket = UtilityConsumptionTotals & {
  /** Identity of the bucket, by grouping. */
  key: string | null;
  label: string | null;
  utilityType?: UtilityType | null;
  meterId?: string | null;
  meterCode?: string | null;
  buildingId?: string | null;
  tenantCompanyId?: string | null;
  /** Only the PERIOD grouping sets these. */
  intervalStart?: string | null;
  /** Unit of measure, when unambiguous across the bucket. */
  uomId?: string | null;
};

/** Abnormal-consumption counts (BE-18J), by status and by type. */
export type UtilityAbnormalSummary = {
  total: number;
  open: number;
  resolved: number;
  dismissed: number;
  /** Count per abnormality type, e.g. `{ HIGH_USAGE: 3 }`. */
  byType: Record<string, number>;
};

/**
 * Verification (BE-18K) and Tenant approval (BE-18L) status summary.
 * Verifications are counted against the abnormalities in scope; approvals
 * against the Tenant utility calculations in scope.
 */
export type UtilityVerificationApprovalSummary = {
  verification: {
    /** Abnormalities in scope that carry no verification at all. */
    unverified: number;
    pending: number;
    approved: number;
    rejected: number;
    reworkRequired: number;
  };
  approval: {
    /** Tenant calculations in scope with no approval binding. */
    unbound: number;
    pending: number;
    approved: number;
    rejected: number;
  };
};

/** The complete utility summary for one scope. */
export type UtilityAggregationSummary = {
  scope: UtilityAggregationScope & { resolvedClientId: string | null };
  filters: {
    utilityType: UtilityType | null;
    from: string | null;
    to: string | null;
    meterScope: UtilityAggregationMeterScope;
  };
  totals: UtilityConsumptionTotals;
  byUtilityType: UtilityAggregationBucket[];
  abnormal: UtilityAbnormalSummary;
  verificationApproval: UtilityVerificationApprovalSummary;
  /** Meters excluded from totals because they are ACTIVE Sub Meters. */
  excludedSubMeterCount: number;
};

/** Raw grouped row returned by the aggregation query. */
export type UtilityAggregationRow = {
  key: string | null;
  label: string | null;
  utilityType: UtilityType | null;
  meterId: string | null;
  meterCode: string | null;
  buildingId: string | null;
  tenantCompanyId: string | null;
  intervalStart: Date | null;
  uomId: string | null;
  consumptionCount: string;
  totalConsumption: string | null;
  meterCount: string;
  periodStart: Date | null;
  periodEnd: Date | null;
};

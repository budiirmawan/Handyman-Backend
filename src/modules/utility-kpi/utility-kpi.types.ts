/**
 * BE-23I — Utility KPI domain types.
 *
 * A read-only reporting KPI projection over the BE-18 Utility domain,
 * reusing the BE-23 reporting foundation established by BE-23F1 /
 * BE-23F2 / BE-23G / BE-23H (same scope resolution, UTC windows,
 * zeroed-KPI convention).
 *
 * NO DUPLICATED UTILITY CALCULATION
 * ---------------------------------
 * BE-18M (`utility-aggregations`) is already the authoritative query
 * layer for utility totals, abnormality counts and verification status.
 * BE-23I therefore DELEGATES every figure to
 * `utilityAggregationService` rather than writing a second set of
 * consumption SQL. That matters because BE-18M encodes non-obvious
 * domain rules this module must not re-derive:
 *
 *   - Sub-meter exclusion. A Sub Meter's usage is physically already
 *     inside its Main Meter's reading, so BE-18M's default
 *     EXCLUDE_SUB_METERS scope prevents double-counting. Re-summing
 *     `utility_meter_consumptions` here would silently double-count.
 *   - Consumption is the BE-18G derived delta between two BE-18E
 *     readings; this module never recomputes a delta.
 *
 * BE-23I contributes only the reporting SHAPE on top: a per-utility-type
 * KPI (electricity / water / gas), the abnormal and verified counters,
 * and a period trend series.
 *
 * No new tables, no migration, no ETL, no warehouse, no writes. This
 * module never mutates Utility domain state.
 */

import type { UtilityType } from '../utility-meters/utility-meter.types';

/** Calendar bucket for the trend series, passed through to BE-18M. */
export const UTILITY_KPI_INTERVALS = ['DAY', 'MONTH', 'YEAR'] as const;
export type UtilityKpiInterval = (typeof UTILITY_KPI_INTERVALS)[number];

export type UtilityKpiFilters = {
  /**
   * Optional. Omitted means "roll up across every Building the caller
   * can access"; supplied means the Building is access-asserted.
   */
  buildingId?: string;
  /** Narrows every figure to one utility type. */
  utilityType?: UtilityType;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC. */
  dateFrom?: string;
  dateTo?: string;
  /** Trend bucket size. Defaults to MONTH. */
  interval?: UtilityKpiInterval;
  /**
   * Whether Sub Meters contribute to totals. Defaults to
   * EXCLUDE_SUB_METERS — see the double-counting note above.
   */
  includeSubMeters?: boolean;
};

/** Consumption figures for one utility type. */
export type PublicUtilityConsumptionKpi = {
  utilityType: UtilityType;
  /** Sum of BE-18G `consumption_value` for the type. */
  totalConsumption: number;
  /** Number of BE-18G consumption records summed. */
  consumptionCount: number;
  /** Distinct Meters contributing. */
  meterCount: number;
  /** Unit of measure, when unambiguous across the bucket. */
  uomId: string | null;
};

/** BE-18J abnormal consumption counters. */
export type PublicUtilityAbnormalKpi = {
  total: number;
  open: number;
  resolved: number;
  dismissed: number;
  /** Count per abnormality type, e.g. `{ HIGH_USAGE: 3 }`. */
  byType: Record<string, number>;
};

/**
 * BE-18K verification counters.
 *
 * Verification in BE-18 targets an ABNORMAL CONSUMPTION (via the shared
 * BE-07 `reviews` primitive), not an individual meter reading — there is
 * no `verified` flag on `utility_meter_readings`. "Verified reading
 * count" is therefore reported as the number of abnormal consumptions
 * carrying a COMPLETED APPROVED verification, plus the surrounding
 * decision counters so the figure is interpretable.
 */
export type PublicUtilityVerificationKpi = {
  /** COMPLETED verifications with an APPROVED decision. */
  verified: number;
  pending: number;
  rejected: number;
  reworkRequired: number;
  /** Abnormalities in scope carrying no verification at all. */
  unverified: number;
};

/** One bucket of the consumption trend series. */
export type PublicUtilityTrendPoint = {
  /** Bucket start instant, ISO-8601. */
  intervalStart: string | null;
  totalConsumption: number;
  consumptionCount: number;
  meterCount: number;
};

export type PublicUtilityKpi = {
  /** Null when the KPI is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the numbers. */
  buildingScope: string[];
  utilityType: UtilityType | null;
  dateFrom: string | null;
  dateTo: string | null;
  interval: UtilityKpiInterval;
  /** The meter scope BE-18M applied when totalling. */
  meterScope: string;
  asOf: string;
  /** Headline totals across every utility type in scope. */
  totals: {
    totalConsumption: number;
    consumptionCount: number;
    meterCount: number;
  };
  /** Per-type consumption. Always present for the three BE-18A types. */
  electricity: PublicUtilityConsumptionKpi;
  water: PublicUtilityConsumptionKpi;
  gas: PublicUtilityConsumptionKpi;
  abnormal: PublicUtilityAbnormalKpi;
  verification: PublicUtilityVerificationKpi;
  trend: PublicUtilityTrendPoint[];
};

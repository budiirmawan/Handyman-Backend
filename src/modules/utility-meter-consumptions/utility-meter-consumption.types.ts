import type { UtilityType } from '../utility-meters/utility-meter.types';
import type { UtilityAggregationInterval } from '../utility-aggregations/utility-aggregation.types';

/**
 * BE-18G — Consumption domain types.
 *
 * A consumption is the derived delta between two authoritative BE-18E Meter
 * Readings on the same Meter:
 *
 *   consumption = current reading value - previous reading value
 *
 * Reading data is never duplicated: a consumption stores references to the
 * two readings plus the derived result. Reading values themselves stay in
 * BE-18E, which remains the single source of truth — the reading summaries
 * exposed on the public shape are read-through context resolved at query
 * time, not stored columns.
 *
 * Append-only: there is no update or delete input type in this module, by
 * design, so calculation history is preserved in full.
 *
 * Out of scope, deliberately: tariffs, rates, cost, invoicing, and any
 * Utility Calculation. Billing never lives in BE-18.
 */

/** Full database record. */
export type UtilityMeterConsumptionRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  previousReadingId: string;
  currentReadingId: string;
  uomId: string;
  /** Raw NUMERIC string from PostgreSQL so no precision is lost in transit. */
  consumptionValue: string;
  periodStart: Date;
  periodEnd: Date;
  calculatedAt: Date;
  calculatedByUserId: string | null;
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Identifying Meter context denormalised into a consumption response. */
export type ConsumptionMeterSummary = {
  id: string;
  code: string;
  name: string;
  utilityType: UtilityType;
  uomId: string;
  buildingId: string;
  status: string;
};

/** Resolved BE-07 UOM context. */
export type ConsumptionUomSummary = {
  id: string;
  code: string;
  name: string;
  symbol: string;
};

/**
 * Read-through view of one endpoint reading. Resolved from BE-18E at query
 * time so the consumption row itself never holds a copy of the value.
 */
export type ConsumptionReadingSummary = {
  id: string;
  readingValue: number;
  readingAt: string;
  source: string;
  readingType: string;
};

/** Safe public representation exposed through the API. */
export type PublicUtilityMeterConsumption = {
  id: string;
  clientId: string;
  buildingId: string;
  meterId: string;
  previousReadingId: string;
  currentReadingId: string;
  uomId: string;
  consumptionValue: number;
  periodStart: string;
  periodEnd: string;
  calculatedAt: string;
  calculatedByUserId: string | null;
  /** BE-18D tenant context as it stood across the period. */
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  meter?: ConsumptionMeterSummary | null;
  uom?: ConsumptionUomSummary | null;
  previousReading?: ConsumptionReadingSummary | null;
  currentReading?: ConsumptionReadingSummary | null;
};

/** Input accepted by POST /utility/meters/:id/consumptions. */
export type CalculateUtilityMeterConsumptionInput = {
  meterId: string;
  /** The closing reading. Required — it anchors the period. */
  currentReadingId: string;
  /**
   * The opening reading. When omitted, BE-18E resolves the reading
   * immediately preceding the current one on the same Meter.
   */
  previousReadingId?: string;
  calculatedByUserId?: string;
  notes?: string | null;
};

/** Fully-resolved data ready for persistence. */
export type NewUtilityMeterConsumption = {
  clientId: string;
  buildingId: string;
  meterId: string;
  previousReadingId: string;
  currentReadingId: string;
  uomId: string;
  consumptionValue: number;
  periodStart: Date;
  periodEnd: Date;
  calculatedByUserId: string | null;
  tenantAssignmentId: string | null;
  tenantCompanyId: string | null;
  notes: string | null;
};

/** Filters shared by the consumption list endpoints. */
export type UtilityMeterConsumptionFilters = {
  meterId?: string;
  tenantCompanyId?: string;
  /** Inclusive bounds applied to the consumption period. */
  from?: Date;
  to?: Date;
  limit?: number;
};

/** Bounded actor-scoped source request for Building × Period trend buckets. */
export type UtilityConsumptionTrendReadRequest = {
  buildingIds: readonly string[];
  utilityTypes?: readonly UtilityType[];
  periodStart: Date;
  periodEnd: Date;
  interval: UtilityAggregationInterval;
};

/** One source-owned Building × Period × Utility Type × UOM bucket. */
export type UtilityConsumptionTrendSourceRow = {
  buildingId: string;
  periodStart: Date;
  periodEnd: Date;
  utilityType: UtilityType;
  uomId: string;
  consumptionValue: string;
  consumptionCount: string;
};

/** Safe public representation of one bounded trend bucket. */
export type PublicUtilityConsumptionTrendBucket = {
  buildingId: string;
  periodStart: string;
  periodEnd: string;
  interval: UtilityAggregationInterval;
  utilityType: UtilityType;
  uomId: string;
  consumptionValue: number;
};

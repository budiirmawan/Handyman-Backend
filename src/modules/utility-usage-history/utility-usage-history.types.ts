import type { UtilityType } from '../utility-meters/utility-meter.types';

/**
 * BE-18H — Usage History domain types.
 *
 * Usage History is a **read-only chronological projection** over the
 * authoritative BE-18G `utility_meter_consumptions` records, each of which
 * already references the two BE-18E readings it was derived from.
 *
 * There is deliberately no `utility_usage_history` table and no writer:
 *
 *   - every field in BE-18H's scope (meter, consumption reference, period,
 *     value, UOM, tenant, building, calculated_at) already exists on the
 *     BE-18G row, so persisting a copy would duplicate source data and
 *     create a second version of the truth that could silently drift;
 *   - "append-oriented history" is already guaranteed upstream — BE-18G is
 *     append-only (no update, no delete), and BE-18E readings are immutable —
 *     so the history cannot be rewritten through any path;
 *   - the repository precedents for history modules in this codebase
 *     (`work-order-history`, `finding-history`) are likewise projections that
 *     own no table.
 *
 * A usage entry therefore *is* a consumption, presented chronologically with
 * its meter / tenant / building context resolved. `usageId` and
 * `consumptionId` intentionally carry the same value: the entry's identity is
 * the source consumption's identity, which keeps the linkage explicit and
 * makes it impossible for the two to disagree.
 *
 * Out of scope, deliberately: tariffs, rates, cost, invoicing and any Utility
 * Calculation. Billing never lives in BE-18.
 */

/** Identifying Meter context resolved into a usage entry. */
export type UsageHistoryMeterSummary = {
  id: string;
  code: string;
  name: string;
  utilityType: UtilityType;
  uomId: string;
  buildingId: string;
  status: string;
};

/** Resolved BE-07 UOM context. */
export type UsageHistoryUomSummary = {
  id: string;
  code: string;
  name: string;
  symbol: string;
};

/**
 * One chronological usage entry.
 *
 * `consumptionId` is the authoritative source record; `previousReadingId` and
 * `currentReadingId` are carried through so a consumer can always walk back
 * to the BE-18E readings behind the figure without this module restating
 * their values.
 */
export type PublicUtilityUsageHistoryEntry = {
  usageId: string;
  consumptionId: string;
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
  meter?: UsageHistoryMeterSummary | null;
  uom?: UsageHistoryUomSummary | null;
};

/**
 * Aggregate context describing a chronological run of usage entries.
 *
 * `totalConsumption` is a presentation-level sum of the entries in the window
 * — a convenience for reading the history, not a stored or billable figure.
 * `uomId` is non-null only when every entry in the window shares one unit;
 * when a meter's configured unit changed part-way through, it is `null` so no
 * caller can mistakenly add incompatible quantities.
 */
export type PublicUtilityUsageHistory = {
  entries: PublicUtilityUsageHistoryEntry[];
  entryCount: number;
  totalConsumption: number;
  uomId: string | null;
  uomConsistent: boolean;
  periodStart: string | null;
  periodEnd: string | null;
};

/** Chronological ordering of the returned history. */
export const USAGE_HISTORY_ORDERS = ['ASC', 'DESC'] as const;
export type UsageHistoryOrder = (typeof USAGE_HISTORY_ORDERS)[number];

export function isUsageHistoryOrder(value: unknown): value is UsageHistoryOrder {
  return (
    typeof value === 'string' &&
    (USAGE_HISTORY_ORDERS as readonly string[]).includes(value)
  );
}

/** Filters shared by the usage history endpoints. */
export type UtilityUsageHistoryFilters = {
  meterId?: string;
  tenantCompanyId?: string;
  buildingId?: string;
  /** Inclusive bounds applied to the consumption period. */
  from?: Date;
  to?: Date;
  /** Defaults to ASC — history reads forward in time. */
  order?: UsageHistoryOrder;
  limit?: number;
};

/** Database-level scope anchoring a history query. */
export type UsageHistoryScope = {
  column: 'meter_id' | 'building_id' | 'tenant_company_id';
  value: string;
};

import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { utilityAggregationService } from '../utility-aggregations';
import type {
  UtilityAbnormalSummary,
  UtilityAggregationBucket,
  UtilityAggregationFilters,
  UtilityAggregationScope,
  UtilityVerificationApprovalSummary,
} from '../utility-aggregations';
import {
  UTILITY_TYPES,
  type UtilityType,
} from '../utility-meters/utility-meter.types';
import type {
  PublicUtilityConsumptionKpi,
  PublicUtilityKpi,
  PublicUtilityTrendPoint,
  UtilityKpiFilters,
} from './utility-kpi.types';
import {
  DEFAULT_UTILITY_KPI_INTERVAL,
  utilityKpiRange,
} from './utility-kpi.validation';

/**
 * BE-23I — Utility KPI service.
 *
 * Read-only, and deliberately thin: every consumption / abnormality /
 * verification figure is DELEGATED to BE-18M
 * (`utilityAggregationService`), which is already the authoritative
 * query layer for those numbers. BE-23I adds only the reporting shape —
 * per-utility-type KPI blocks, the verified counter and the trend
 * series.
 *
 * Duplicating BE-18M's SQL here would risk disagreeing with it, most
 * dangerously over sub-meter exclusion (a Sub Meter's usage is already
 * inside its Main Meter's reading). Delegation makes that impossible.
 *
 * Building access is asserted per request, matching the earlier BE-23
 * parts: an explicit `buildingId` is access-checked, and an omitted one
 * rolls up across exactly the Buildings the caller can reach. BE-18M
 * takes a single-anchor scope, so a rollup fans out one delegated call
 * per accessible Building and sums the results here — the arithmetic is
 * pure addition over BE-18M's own outputs, never a re-derivation.
 *
 * This module never mutates Utility domain state.
 */

const EMPTY_ABNORMAL: UtilityAbnormalSummary = {
  total: 0,
  open: 0,
  resolved: 0,
  dismissed: 0,
  byType: {},
};

function emptyConsumption(utilityType: UtilityType): PublicUtilityConsumptionKpi {
  return {
    utilityType,
    totalConsumption: 0,
    consumptionCount: 0,
    meterCount: 0,
    uomId: null,
  };
}

/** Rounds to 4dp, normalising -0 to 0. Consumption can be fractional. */
function round4(value: number): number {
  const rounded = Math.round(value * 10000) / 10000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

async function resolveScope(
  filters: UtilityKpiFilters,
  userId: string,
): Promise<{ buildingIds: string[] }> {
  if (filters.buildingId) {
    const building = await buildingRepository.findById(filters.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    return { buildingIds: [filters.buildingId] };
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(
    userId,
  );
  return { buildingIds };
}

/** Builds the BE-18M filter object from the BE-23I reporting filters. */
export function toUtilityAggregationFilters(
  filters: UtilityKpiFilters,
  range: { start: Date | null; end: Date | null },
): UtilityAggregationFilters {
  return {
    ...(filters.utilityType ? { utilityType: filters.utilityType } : {}),
    ...(range.start ? { from: range.start } : {}),
    ...(range.end ? { to: range.end } : {}),
    meterScope: filters.includeSubMeters ? 'ALL_METERS' : 'EXCLUDE_SUB_METERS',
    interval: filters.interval ?? DEFAULT_UTILITY_KPI_INTERVAL,
  };
}

export async function getUtilityKpi(
  filters: UtilityKpiFilters,
  userId: string,
): Promise<PublicUtilityKpi> {
  const { buildingIds } = await resolveScope(filters, userId);
  return getUtilityKpiForAuthorizedBuildingScope(filters, userId, buildingIds);
}

/**
 * Internal BE-23I projection for an already-authorized Building set. BE-24
 * reuses this path so Client-selected multi-Building summaries cannot diverge
 * from the public KPI calculation.
 */
export async function getUtilityKpiForAuthorizedBuildingScope(
  filters: UtilityKpiFilters,
  userId: string,
  buildingIds: string[],
  asOf = new Date(),
): Promise<PublicUtilityKpi> {
  const range = utilityKpiRange(filters);
  const aggregationFilters = toUtilityAggregationFilters(filters, range);
  const interval = filters.interval ?? DEFAULT_UTILITY_KPI_INTERVAL;

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    utilityType: filters.utilityType ?? null,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    interval,
    meterScope: aggregationFilters.meterScope ?? 'EXCLUDE_SUB_METERS',
    asOf: asOf.toISOString(),
  };

  // No accessible buildings — return a well-formed zeroed KPI rather
  // than a 403, matching the earlier BE-23 reporting convention.
  if (buildingIds.length === 0) {
    return {
      ...base,
      totals: { totalConsumption: 0, consumptionCount: 0, meterCount: 0 },
      electricity: emptyConsumption('ELECTRICITY'),
      water: emptyConsumption('WATER'),
      gas: emptyConsumption('GAS'),
      abnormal: { ...EMPTY_ABNORMAL, byType: {} },
      verification: {
        verified: 0,
        pending: 0,
        rejected: 0,
        reworkRequired: 0,
        unverified: 0,
      },
      trend: [],
    };
  }

  // BE-18M is anchored to exactly one scope, so fan out per Building.
  const perBuilding = await Promise.all(
    buildingIds.map(async (buildingId) => {
      const scope: UtilityAggregationScope = { buildingId };
      const [byType, abnormal, verificationApproval, trend] = await Promise.all(
        [
          utilityAggregationService.aggregateUtilityConsumption(
            scope,
            aggregationFilters,
            'UTILITY_TYPE',
            userId,
          ),
          utilityAggregationService.getUtilityAbnormalSummary(
            scope,
            aggregationFilters,
            userId,
          ),
          utilityAggregationService.getUtilityVerificationApprovalSummary(
            scope,
            aggregationFilters,
            userId,
          ),
          utilityAggregationService.aggregateUtilityConsumption(
            scope,
            aggregationFilters,
            'PERIOD',
            userId,
          ),
        ],
      );
      return { byType, abnormal, verificationApproval, trend };
    }),
  );

  /* ---------------- Per-utility-type consumption ---------------- */

  const byType = new Map<UtilityType, PublicUtilityConsumptionKpi>();
  for (const type of UTILITY_TYPES) {
    byType.set(type, emptyConsumption(type));
  }

  for (const result of perBuilding) {
    for (const bucket of result.byType) {
      const type = (bucket.utilityType ?? null) as UtilityType | null;
      if (!type || !byType.has(type)) {
        continue;
      }
      const current = byType.get(type)!;
      current.totalConsumption = round4(
        current.totalConsumption + bucket.totalConsumption,
      );
      current.consumptionCount += bucket.consumptionCount;
      current.meterCount += bucket.meterCount;
      // Only surface a UOM when it is unambiguous across everything summed.
      if (bucket.uomId) {
        current.uomId =
          current.uomId === null || current.uomId === bucket.uomId
            ? bucket.uomId
            : null;
      }
    }
  }

  const electricity = byType.get('ELECTRICITY')!;
  const water = byType.get('WATER')!;
  const gas = byType.get('GAS')!;

  const totals = [electricity, water, gas].reduce(
    (acc, entry) => ({
      totalConsumption: round4(acc.totalConsumption + entry.totalConsumption),
      consumptionCount: acc.consumptionCount + entry.consumptionCount,
      meterCount: acc.meterCount + entry.meterCount,
    }),
    { totalConsumption: 0, consumptionCount: 0, meterCount: 0 },
  );

  /* ---------------- Abnormal + verification ---------------- */

  const abnormal = perBuilding.reduce<UtilityAbnormalSummary>(
    (acc, result) => {
      acc.total += result.abnormal.total;
      acc.open += result.abnormal.open;
      acc.resolved += result.abnormal.resolved;
      acc.dismissed += result.abnormal.dismissed;
      for (const [type, count] of Object.entries(result.abnormal.byType)) {
        acc.byType[type] = (acc.byType[type] ?? 0) + count;
      }
      return acc;
    },
    { total: 0, open: 0, resolved: 0, dismissed: 0, byType: {} },
  );

  const verificationTotals = perBuilding.reduce<
    UtilityVerificationApprovalSummary['verification']
  >(
    (acc, result) => {
      const v = result.verificationApproval.verification;
      acc.unverified += v.unverified;
      acc.pending += v.pending;
      acc.approved += v.approved;
      acc.rejected += v.rejected;
      acc.reworkRequired += v.reworkRequired;
      return acc;
    },
    { unverified: 0, pending: 0, approved: 0, rejected: 0, reworkRequired: 0 },
  );

  /* ---------------- Trend ---------------- */

  const trendBuckets = new Map<string, PublicUtilityTrendPoint>();
  for (const result of perBuilding) {
    for (const bucket of result.trend as UtilityAggregationBucket[]) {
      const key = bucket.intervalStart ?? bucket.key ?? '';
      const existing = trendBuckets.get(key);
      if (existing) {
        existing.totalConsumption = round4(
          existing.totalConsumption + bucket.totalConsumption,
        );
        existing.consumptionCount += bucket.consumptionCount;
        existing.meterCount += bucket.meterCount;
      } else {
        trendBuckets.set(key, {
          intervalStart: bucket.intervalStart ?? null,
          totalConsumption: round4(bucket.totalConsumption),
          consumptionCount: bucket.consumptionCount,
          meterCount: bucket.meterCount,
        });
      }
    }
  }

  const trend = [...trendBuckets.values()].sort((a, b) => {
    if (a.intervalStart === b.intervalStart) return 0;
    if (a.intervalStart === null) return -1;
    if (b.intervalStart === null) return 1;
    return a.intervalStart < b.intervalStart ? -1 : 1;
  });

  return {
    ...base,
    totals,
    electricity,
    water,
    gas,
    abnormal,
    verification: {
      // BE-18K verification targets an abnormal consumption; an APPROVED
      // COMPLETED review is the domain's notion of "verified".
      verified: verificationTotals.approved,
      pending: verificationTotals.pending,
      rejected: verificationTotals.rejected,
      reworkRequired: verificationTotals.reworkRequired,
      unverified: verificationTotals.unverified,
    },
    trend,
  };
}

export const utilityKpiService = {
  getUtilityKpi,
  getUtilityKpiForAuthorizedBuildingScope,
  toUtilityAggregationFilters,
};

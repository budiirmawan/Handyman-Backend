import {
  createManagementReadModelContract,
  resolveManagementReadScope,
} from '../management-read-scope';
import { utilityAggregationService } from '../utility-aggregations';
import { buildingNotFoundError } from '../buildings';
import { contextAccessService } from '../context-access';
import { managementUtilitySummaryRepository } from './management-utility-summary.repository';
import type { UtilityAggregationFilters } from '../utility-aggregations';
import {
  getUtilityKpiForAuthorizedBuildingScope,
  toUtilityAggregationFilters,
  utilityKpiRange,
  type UtilityKpiFilters,
} from '../utility-kpi';
import { UTILITY_TYPES, type UtilityType } from '../utility-meters';
import type {
  ManagementTenantUtilityRow,
  ManagementUtilitySummaryQuery,
  PublicManagementUtilitySummary,
  BuildingUtilityOperationalSummaryQuery,
  PublicBuildingUtilityOperationalSummary,
} from './management-utility-summary.types';

/** BE-24 PART 06A — thin projection over BE-23I and BE-18M only. */
export async function getManagementUtilitySummary(
  query: ManagementUtilitySummaryQuery,
  userId: string,
): Promise<PublicManagementUtilitySummary> {
  const resolved = await resolveManagementReadScope(query.scope, userId);
  const { context } = resolved;
  const filters = {
    interval: query.interval,
    includeSubMeters: query.includeSubMeters,
  };
  const kpiFilters: UtilityKpiFilters = {
    dateFrom: query.scope.dateFrom,
    dateTo: query.scope.dateTo,
    interval: query.interval,
    includeSubMeters: query.includeSubMeters,
  };

  const kpi = await getUtilityKpiForAuthorizedBuildingScope(
    kpiFilters,
    userId,
    context.scope.buildingIds,
    new Date(context.asOf),
  );
  const tenantUtility = await getTenantUtilityRows(
    context.scope.buildingIds,
    kpiFilters,
    userId,
  );
  const current = kpi.trend.at(-1) ?? null;
  const previous = kpi.trend.at(-2) ?? null;

  return createManagementReadModelContract(context, filters, {
    electricity: kpi.electricity,
    water: kpi.water,
    gas: kpi.gas,
    abnormalConsumption: kpi.abnormal,
    verifiedReadingSummary: kpi.verification,
    tenantUtility,
    periodComparison: {
      interval: kpi.interval,
      previous,
      current,
    },
  });
}

async function getTenantUtilityRows(
  buildingIds: string[],
  filters: UtilityKpiFilters,
  userId: string,
): Promise<ManagementTenantUtilityRow[]> {
  if (buildingIds.length === 0) return [];
  const baseFilters = toUtilityAggregationFilters(
    filters,
    utilityKpiRange(filters),
  );

  const perScope = await Promise.all(
    buildingIds.flatMap((buildingId) =>
      UTILITY_TYPES.map(async (utilityType) => ({
        buildingId,
        utilityType,
        rows: await utilityAggregationService.aggregateUtilityConsumption(
          { buildingId },
          withUtilityType(baseFilters, utilityType),
          'TENANT',
          userId,
        ),
      })),
    ),
  );

  return perScope
    .flatMap(({ buildingId, utilityType, rows }) =>
      rows.flatMap((row): ManagementTenantUtilityRow[] =>
        row.tenantCompanyId
          ? [
              {
                buildingId,
                tenantCompanyId: row.tenantCompanyId,
                tenantName: row.label,
                utilityType,
                totalConsumption: row.totalConsumption,
                consumptionCount: row.consumptionCount,
                meterCount: row.meterCount,
                uomId: row.uomId ?? null,
                periodStart: row.periodStart,
                periodEnd: row.periodEnd,
              },
            ]
          : [],
      ),
    )
    .sort(
      (left, right) =>
        left.buildingId.localeCompare(right.buildingId) ||
        left.utilityType.localeCompare(right.utilityType) ||
        left.tenantCompanyId.localeCompare(right.tenantCompanyId),
    );
}

function withUtilityType(
  filters: UtilityAggregationFilters,
  utilityType: UtilityType,
): UtilityAggregationFilters {
  return { ...filters, utilityType };
}

/** PART 16 — read-only exact-period Building operational snapshot. */
export async function getBuildingUtilityOperationalSummary(
  query: BuildingUtilityOperationalSummaryQuery,
  userId: string,
): Promise<PublicBuildingUtilityOperationalSummary> {
  await contextAccessService.assertBuildingAccess(userId, query.buildingId);
  const clientId = await managementUtilitySummaryRepository.resolveBuildingClient(query.buildingId);
  if (!clientId) throw buildingNotFoundError();
  const [reconciliations, meters, exceptions, billingReadiness] = await Promise.all([
    managementUtilitySummaryRepository.readReconciliations(query.buildingId, query.periodStart, query.periodEnd),
    managementUtilitySummaryRepository.readMeterOperations(query.buildingId, query.periodStart, query.periodEnd),
    managementUtilitySummaryRepository.readExceptionSummary(query.buildingId),
    managementUtilitySummaryRepository.readBillingReadiness(query.buildingId, query.periodStart, query.periodEnd),
  ]);
  return {
    clientId,
    buildingId: query.buildingId,
    reportingPeriod: { start: query.periodStart.toISOString(), end: query.periodEnd.toISOString() },
    reconciliations,
    meters,
    exceptions,
    billingReadiness,
    asOf: new Date().toISOString(),
  };
}

export const managementUtilitySummaryService = {
  getBuildingUtilityOperationalSummary,
  getManagementUtilitySummary,
};

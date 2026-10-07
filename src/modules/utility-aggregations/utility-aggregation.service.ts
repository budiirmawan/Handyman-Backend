import { clientNotFoundError, clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import {
  tenantCompanyNotFoundError,
  tenantCompanyRepository,
} from '../tenant-companies';
import { utilityMeterNotFoundError } from '../utility-meters/utility-meter.errors';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import {
  utilityAggregationPeriodInvalidError,
  utilityAggregationScopeRequiredError,
} from './utility-aggregation.errors';
import { utilityAggregationRepository } from './utility-aggregation.repository';
import type {
  UtilityAbnormalSummary,
  UtilityAggregationBucket,
  UtilityAggregationFilters,
  UtilityAggregationGrouping,
  UtilityAggregationRow,
  UtilityAggregationScope,
  UtilityAggregationSummary,
  UtilityConsumptionTotals,
  UtilityVerificationApprovalSummary,
} from './utility-aggregation.types';

/**
 * BE-18M — Utility Aggregation service.
 *
 * Summarises authoritative BE-18 data; it stores nothing and changes nothing.
 * There is no aggregation table, no snapshot and no nightly roll-up job — a
 * summary is computed from the source rows at request time, so it cannot go
 * stale or disagree with the records it reports. That also keeps this from
 * becoming a BI / reporting warehouse, which BE-18M explicitly is not.
 *
 * Authorities reused, never re-derived:
 *   - consumption values, periods, tenant snapshot → BE-18G
 *   - Main / Sub Meter relationships               → BE-18C
 *   - Meter identity, Client / Building, UOM       → BE-18A
 *   - Tenant Meter context                         → BE-18D (via BE-18G)
 *   - abnormality counts                           → BE-18J
 *   - verification decisions                       → BE-18K (BE-07 reviews)
 *   - Tenant approval decisions                    → BE-18L (BE-14H bindings)
 *   - Client / Building access                     → BE-02G
 *
 * Double counting is the central correctness rule here. A Sub Meter measures
 * electricity that already flowed through its Main Meter, so adding both
 * counts the same energy twice. By default every total excludes Meters that
 * are an ACTIVE Sub Meter of another Meter, and reports how many were
 * excluded so the omission is visible rather than silent.
 *
 * Out of scope, deliberately: tariffs, cost, billing, invoicing, accounting.
 */

function numeric(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toTotals(row: UtilityAggregationRow): UtilityConsumptionTotals {
  return {
    consumptionCount: Number(row.consumptionCount ?? 0),
    totalConsumption: numeric(row.totalConsumption),
    meterCount: Number(row.meterCount ?? 0),
    periodStart: row.periodStart ? row.periodStart.toISOString() : null,
    periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
  };
}

function toBucket(row: UtilityAggregationRow): UtilityAggregationBucket {
  return {
    key: row.key,
    label: row.label,
    utilityType: row.utilityType,
    meterId: row.meterId,
    meterCode: row.meterCode,
    buildingId: row.buildingId,
    tenantCompanyId: row.tenantCompanyId,
    intervalStart: row.intervalStart ? row.intervalStart.toISOString() : null,
    uomId: row.uomId,
    ...toTotals(row),
  };
}

/**
 * BE-02G / Client isolation — resolves the requested scope, proves the actor
 * may see it, and returns the Client the aggregate belongs to.
 *
 * Exactly one anchor is required. Anchoring is what makes an aggregate safe:
 * an unanchored SUM would silently cross Client boundaries.
 */
async function assertScopeAccess(
  scope: UtilityAggregationScope,
  actorUserId?: string,
): Promise<string | null> {
  const anchors = [
    scope.clientId,
    scope.buildingId,
    scope.meterId,
    scope.tenantCompanyId,
  ].filter(Boolean);
  if (anchors.length !== 1) {
    throw utilityAggregationScopeRequiredError();
  }

  if (scope.meterId) {
    const meter = await utilityMeterRepository.findById(scope.meterId);
    if (!meter) {
      throw utilityMeterNotFoundError();
    }
    await assertBuildingAccess(actorUserId, meter.buildingId);
    return meter.clientId;
  }

  if (scope.buildingId) {
    await assertBuildingAccess(actorUserId, scope.buildingId);
    return null;
  }

  if (scope.tenantCompanyId) {
    const tenantCompany = await tenantCompanyRepository.findById(
      scope.tenantCompanyId,
    );
    if (!tenantCompany) {
      throw tenantCompanyNotFoundError();
    }
    await assertClientAccess(actorUserId, tenantCompany.clientId);
    return tenantCompany.clientId;
  }

  const client = await clientRepository.findById(scope.clientId!);
  if (!client) {
    throw clientNotFoundError();
  }
  await assertClientAccess(actorUserId, client.id);
  return client.id;
}

async function assertBuildingAccess(
  actorUserId: string | undefined,
  buildingId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessBuilding(actorUserId, buildingId))) {
    throw buildingAccessDeniedError();
  }
}

async function assertClientAccess(
  actorUserId: string | undefined,
  clientId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function assertPeriod(filters: UtilityAggregationFilters): void {
  if (filters.from && filters.to && filters.to < filters.from) {
    throw utilityAggregationPeriodInvalidError();
  }
}

/**
 * GET /utility/aggregations/summary — the headline utility summary: totals,
 * a utility-type breakdown, abnormality counts and the verification /
 * approval status summary for one scope.
 */
export async function getUtilitySummary(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
  actorUserId?: string,
): Promise<UtilityAggregationSummary> {
  const resolvedClientId = await assertScopeAccess(scope, actorUserId);
  assertPeriod(filters);

  const [totalsRow, byUtilityType, abnormal, verificationApproval, excluded] =
    await Promise.all([
      utilityAggregationRepository.totalConsumption(scope, filters),
      utilityAggregationRepository.aggregateConsumption(
        scope,
        filters,
        'UTILITY_TYPE',
      ),
      utilityAggregationRepository.summarizeAbnormal(scope, filters),
      utilityAggregationRepository.summarizeVerificationApproval(
        scope,
        filters,
      ),
      utilityAggregationRepository.countExcludedSubMeters(scope, filters),
    ]);

  return {
    scope: { ...scope, resolvedClientId },
    filters: {
      utilityType: filters.utilityType ?? null,
      from: filters.from ? filters.from.toISOString() : null,
      to: filters.to ? filters.to.toISOString() : null,
      meterScope: filters.meterScope ?? 'EXCLUDE_SUB_METERS',
    },
    totals: toTotals(totalsRow),
    byUtilityType: byUtilityType.map(toBucket),
    abnormal,
    verificationApproval,
    excludedSubMeterCount: excluded,
  };
}

/**
 * GET /utility/aggregations/consumption — consumption totals grouped by
 * utility type, Meter, Building, Tenant or period.
 */
export async function aggregateUtilityConsumption(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
  grouping: UtilityAggregationGrouping,
  actorUserId?: string,
): Promise<UtilityAggregationBucket[]> {
  await assertScopeAccess(scope, actorUserId);
  assertPeriod(filters);

  const rows = await utilityAggregationRepository.aggregateConsumption(
    scope,
    filters,
    grouping,
  );
  return rows.map(toBucket);
}

/** GET /utility/aggregations/abnormal — BE-18J counts for the scope. */
export async function getUtilityAbnormalSummary(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
  actorUserId?: string,
): Promise<UtilityAbnormalSummary> {
  await assertScopeAccess(scope, actorUserId);
  assertPeriod(filters);
  return utilityAggregationRepository.summarizeAbnormal(scope, filters);
}

/**
 * GET /utility/aggregations/verification-approval — BE-18K verification and
 * BE-18L Tenant approval status counts for the scope.
 */
export async function getUtilityVerificationApprovalSummary(
  scope: UtilityAggregationScope,
  filters: UtilityAggregationFilters,
  actorUserId?: string,
): Promise<UtilityVerificationApprovalSummary> {
  await assertScopeAccess(scope, actorUserId);
  assertPeriod(filters);
  return utilityAggregationRepository.summarizeVerificationApproval(
    scope,
    filters,
  );
}

export const utilityAggregationService = {
  aggregateUtilityConsumption,
  getUtilityAbnormalSummary,
  getUtilitySummary,
  getUtilityVerificationApprovalSummary,
};

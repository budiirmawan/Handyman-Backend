import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  completionRate,
  EMPTY_TENANT_SERVICE_ROW,
  EMPTY_VENDOR_WORK_ROW,
  round2,
  toNumber,
  vendorTenantKpiRepository,
  type TenantServiceKpiRow,
  type VendorWorkKpiRow,
} from './vendor-tenant-kpi.repository';
import type {
  PublicVendorPerformanceRow,
  PublicVendorTenantKpi,
  VendorTenantKpiFilters,
} from './vendor-tenant-kpi.types';
import {
  DEFAULT_OVERDUE_AFTER_DAYS,
  vendorTenantKpiRange,
} from './vendor-tenant-kpi.validation';

/**
 * BE-23H — Vendor / Tenant KPI service.
 *
 * Read-only. Building access is asserted per request: an explicit
 * `buildingId` is access-checked, and an omitted one rolls the KPI up
 * across exactly the Buildings the caller can reach, so cross-Building
 * and cross-Client leakage is impossible.
 *
 * This module never mutates BE-06 / BE-15 Vendor or BE-14 Tenant state —
 * it only reads their authoritative records.
 */

async function resolveScope(
  filters: VendorTenantKpiFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = vendorTenantKpiRange(filters);
  if (filters.buildingId) {
    const building = await buildingRepository.findById(filters.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    return {
      start: range.start,
      end: range.end,
      buildingIds: [filters.buildingId],
    };
  }
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(
    userId,
  );
  return { start: range.start, end: range.end, buildingIds };
}

export function projectVendorWorkKpi(row: VendorWorkKpiRow) {
  const hours = toNumber(row.total_hours);
  return {
    total: row.total,
    notStarted: row.not_started,
    inProgress: row.in_progress,
    onHold: row.on_hold,
    completed: row.completed,
    outstanding: row.outstanding,
    overdue: row.overdue,
    completionRate: completionRate(row.completed, row.total),
    averageCompletionHours: row.measured > 0 ? round2(hours / row.measured) : 0,
  };
}

export function projectTenantServiceKpi(row: TenantServiceKpiRow) {
  // Cancelled requests were withdrawn, never fulfilled, so they are
  // excluded from the completion-rate denominator — counting them would
  // unfairly depress the rate.
  const actionable = row.total - row.cancelled;
  return {
    total: row.total,
    open: row.open,
    converted: row.converted,
    cancelled: row.cancelled,
    completed: row.completed,
    outstanding: row.outstanding,
    completionRate: completionRate(row.completed, actionable),
    byPriority: {
      low: row.priority_low,
      medium: row.priority_medium,
      high: row.priority_high,
      critical: row.priority_critical,
    },
  };
}

/**
 * Shared BE-23 age threshold used by elapsed-age reporting projections.
 * It is a reporting boundary, not a source-domain due date or SLA.
 */
export function vendorTenantKpiOverdueBefore(
  asOf: Date,
  overdueAfterDays: number,
): Date {
  return new Date(asOf.getTime() - overdueAfterDays * 86400000);
}

export async function getVendorTenantKpi(
  filters: VendorTenantKpiFilters,
  userId: string,
): Promise<PublicVendorTenantKpi> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);
  const overdueAfterDays =
    filters.overdueAfterDays ?? DEFAULT_OVERDUE_AFTER_DAYS;
  const asOf = new Date();
  const overdueBefore = vendorTenantKpiOverdueBefore(asOf, overdueAfterDays);

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    overdueAfterDays,
    asOf: asOf.toISOString(),
  };

  // No accessible buildings — return a well-formed zeroed KPI rather
  // than a 403, matching the earlier BE-23 reporting convention.
  if (buildingIds.length === 0) {
    return {
      ...base,
      vendorWork: projectVendorWorkKpi(EMPTY_VENDOR_WORK_ROW),
      vendorPerformance: [],
      tenantService: projectTenantServiceKpi(EMPTY_TENANT_SERVICE_ROW),
    };
  }

  const [vendorWork, vendorPerformance, tenantService]: [
    VendorWorkKpiRow,
    PublicVendorPerformanceRow[],
    TenantServiceKpiRow,
  ] = await Promise.all([
    vendorTenantKpiRepository.getVendorWorkKpi(
      buildingIds,
      filters,
      start,
      end,
      overdueBefore,
    ),
    vendorTenantKpiRepository.getVendorPerformance(
      buildingIds,
      filters,
      start,
      end,
      overdueBefore,
    ),
    vendorTenantKpiRepository.getTenantServiceKpi(
      buildingIds,
      filters,
      start,
      end,
    ),
  ]);

  return {
    ...base,
    vendorWork: projectVendorWorkKpi(vendorWork),
    vendorPerformance,
    tenantService: projectTenantServiceKpi(tenantService),
  };
}

export const vendorTenantKpiService = {
  getVendorTenantKpi,
};

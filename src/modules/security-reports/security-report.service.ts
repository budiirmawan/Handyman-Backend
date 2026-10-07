import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { securityReportRepository } from './security-report.repository';
import type {
  PublicIncidentReadinessDatasetRow,
  PublicKeyControlDatasetRow,
  PublicLostFoundDatasetRow,
  PublicPatrolDatasetRow,
  PublicSecurityFindingDatasetRow,
  PublicSecurityPostDatasetRow,
  PublicSecuritySummary,
  PublicShiftHandoverDatasetRow,
  PublicVisitorBindingDatasetRow,
  SecurityReportFilters,
} from './security-report.types';
import { reportRange } from './security-report.validation';

/**
 * BE-12M — Security Reporting Dataset service.
 *
 * A read-only reporting query layer over the authoritative BE-12 and
 * shared operational records. Building access is asserted per
 * request; every dataset query is scoped to one or more Buildings
 * the caller can access, so cross-Building and cross-Client leakage
 * is impossible.
 *
 * The summary endpoint is the only one that accepts an omitted
 * `buildingId`; in that case the service rolls the report up across
 * every building the caller can access via
 * `contextAccessService.getAccessibleBuildingIds`. Dataset endpoints
 * require a `buildingId` because per-Building scope is the
 * authoritative isolation boundary for the BE-12 records.
 *
 * No ETL / BI / warehouse logic exists here. No ETL writes, no
 * materialized views, no chart payloads. The repository's queries
 * are direct reads of the BE-12 source tables.
 */

async function resolveBuildingScope(
  filters: SecurityReportFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = reportRange(filters);
  if (filters.buildingId) {
    const building = await buildingRepository.findById(filters.buildingId);
    if (!building) {
      throw buildingNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    return { start: range.start, end: range.end, buildingIds: [filters.buildingId] };
  }
  // Summary endpoint with no buildingId: roll up across every
  // accessible building.
  const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  return { start: range.start, end: range.end, buildingIds };
}

export async function getSecuritySummary(
  filters: SecurityReportFilters,
  userId: string,
): Promise<PublicSecuritySummary> {
  const { start, end, buildingIds } = await resolveBuildingScope(filters, userId);
  if (buildingIds.length === 0) {
    // Caller has no accessible buildings — return an empty summary
    // so the endpoint stays useful for first-time-admin bootstrap
    // flows.
    return securityReportRepository.toPublicSecuritySummary(
      filters.buildingId ?? null,
      [],
      start,
      end,
      emptySecuritySummaryRow(),
    );
  }
  const row = await securityReportRepository.getSecuritySummary(
    buildingIds,
    start,
    end,
  );
  return securityReportRepository.toPublicSecuritySummary(
    filters.buildingId ?? null,
    buildingIds,
    start,
    end,
    row,
  );
}

export async function getPatrolDataset(
  filters: SecurityReportFilters,
  userId: string,
): Promise<PublicPatrolDatasetRow[]> {
  const { start, end, buildingIds } = await resolveBuildingScope(filters, userId);
  if (buildingIds.length === 0) return [];
  return securityReportRepository.getPatrolDataset(buildingIds, filters, start, end);
}

export async function getSecurityPostDataset(
  filters: SecurityReportFilters,
  userId: string,
): Promise<PublicSecurityPostDatasetRow[]> {
  const { buildingIds } = await resolveBuildingScope(filters, userId);
  if (buildingIds.length === 0) return [];
  return securityReportRepository.getSecurityPostDataset(buildingIds, filters);
}

export async function getSecurityFindingDataset(
  filters: SecurityReportFilters,
  userId: string,
): Promise<PublicSecurityFindingDatasetRow[]> {
  const { start, end, buildingIds } = await resolveBuildingScope(filters, userId);
  if (buildingIds.length === 0) return [];
  return securityReportRepository.getSecurityFindingDataset(
    buildingIds,
    filters,
    start,
    end,
  );
}

export async function getShiftHandoverDataset(
  filters: SecurityReportFilters,
  userId: string,
): Promise<PublicShiftHandoverDatasetRow[]> {
  const { start, end, buildingIds } = await resolveBuildingScope(filters, userId);
  if (buildingIds.length === 0) return [];
  return securityReportRepository.getShiftHandoverDataset(
    buildingIds,
    filters,
    start,
    end,
  );
}

export async function getIncidentReadinessDataset(
  filters: SecurityReportFilters,
  userId: string,
): Promise<PublicIncidentReadinessDatasetRow[]> {
  const { buildingIds } = await resolveBuildingScope(filters, userId);
  if (buildingIds.length === 0) return [];
  return securityReportRepository.getIncidentReadinessDataset(buildingIds, filters);
}

export async function getVisitorBindingDataset(
  filters: SecurityReportFilters,
  userId: string,
): Promise<PublicVisitorBindingDatasetRow[]> {
  const { buildingIds } = await resolveBuildingScope(filters, userId);
  if (buildingIds.length === 0) return [];
  return securityReportRepository.getVisitorBindingDataset(buildingIds, filters);
}

export async function getKeyControlDataset(
  filters: SecurityReportFilters,
  userId: string,
): Promise<PublicKeyControlDatasetRow[]> {
  const { buildingIds } = await resolveBuildingScope(filters, userId);
  if (buildingIds.length === 0) return [];
  return securityReportRepository.getKeyControlDataset(buildingIds, filters);
}

export async function getLostFoundDataset(
  filters: SecurityReportFilters,
  userId: string,
): Promise<PublicLostFoundDatasetRow[]> {
  const { start, end, buildingIds } = await resolveBuildingScope(filters, userId);
  if (buildingIds.length === 0) return [];
  return securityReportRepository.getLostFoundDataset(
    buildingIds,
    filters,
    start,
    end,
  );
}

function emptySecuritySummaryRow() {
  return {
    posts_total: 0,
    posts_active: 0,
    posts_inactive: 0,
    routes_total: 0,
    routes_active: 0,
    routes_inactive: 0,
    patrols_scheduled: 0,
    patrols_in_progress: 0,
    patrols_completed: 0,
    patrols_cancelled: 0,
    checklists_open: 0,
    checklists_completed: 0,
    findings_open: 0,
    findings_verified: 0,
    findings_closed: 0,
    shift_handovers_active: 0,
    shift_handovers_draft: 0,
    shift_handovers_ready: 0,
    shift_handovers_acknowledged: 0,
    incident_readiness_not_ready: 0,
    incident_readiness_partial: 0,
    incident_readiness_ready: 0,
    incident_readiness_active: 0,
    visitor_bindings_active: 0,
    visitor_bindings_inactive: 0,
    keys_available: 0,
    keys_issued: 0,
    keys_overdue: 0,
    keys_lost: 0,
    keys_inactive: 0,
    keys_open_custody: 0,
    lost_found_found: 0,
    lost_found_in_custody: 0,
    lost_found_claimed: 0,
    lost_found_returned: 0,
    lost_found_disposed: 0,
    lost_found_closed: 0,
  };
}

export const securityReportService = {
  getIncidentReadinessDataset,
  getKeyControlDataset,
  getLostFoundDataset,
  getPatrolDataset,
  getSecurityFindingDataset,
  getSecurityPostDataset,
  getSecuritySummary,
  getShiftHandoverDataset,
  getVisitorBindingDataset,
};

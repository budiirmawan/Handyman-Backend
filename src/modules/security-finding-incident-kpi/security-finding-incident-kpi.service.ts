import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  EMPTY_FINDING_KPI_ROW,
  EMPTY_HANDOVER_KPI_ROW,
  EMPTY_INCIDENT_KPI_ROW,
  securityFindingIncidentKpiRepository,
  toStatusCounts,
  type FindingKpiRow,
  type HandoverKpiRow,
  type IncidentKpiRow,
} from './security-finding-incident-kpi.repository';
import type {
  PublicSecurityFindingIncidentKpi,
  SecurityFindingIncidentKpiFilters,
} from './security-finding-incident-kpi.types';
import { findingIncidentKpiRange } from './security-finding-incident-kpi.validation';

/**
 * BE-23F2 — Security Finding / Incident / Handover KPI service.
 *
 * Read-only. Building access is asserted per request: an explicit
 * `buildingId` is access-checked, and an omitted one rolls the KPI up
 * across exactly the Buildings the caller can reach, so cross-Building
 * and cross-Client leakage is impossible.
 *
 * This module never mutates BE-09 / BE-21 / BE-12 state — it only reads
 * their authoritative records. Patrol KPI belongs to BE-23F1 and is not
 * duplicated here.
 */

async function resolveScope(
  filters: SecurityFindingIncidentKpiFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = findingIncidentKpiRange(filters);
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

function projectFindings(row: FindingKpiRow) {
  return {
    total: row.total,
    open: row.open,
    assigned: row.assigned,
    inProgress: row.in_progress,
    pendingReview: row.pending_review,
    rejected: row.rejected,
    reworkRequired: row.rework_required,
    resubmitted: row.resubmitted,
    verified: row.verified,
    closed: row.closed,
    cancelled: row.cancelled,
    outstanding: row.outstanding,
    byStatus: toStatusCounts([
      ['OPEN', row.open],
      ['ASSIGNED', row.assigned],
      ['IN_PROGRESS', row.in_progress],
      ['PENDING_REVIEW', row.pending_review],
      ['REJECTED', row.rejected],
      ['REWORK_REQUIRED', row.rework_required],
      ['RESUBMITTED', row.resubmitted],
      ['VERIFIED', row.verified],
      ['CLOSED', row.closed],
      ['CANCELLED', row.cancelled],
    ]),
  };
}

function projectIncidents(row: IncidentKpiRow) {
  return {
    total: row.total,
    reported: row.reported,
    cancelled: row.cancelled,
    closed: row.closed,
    byType: {
      operational: row.type_operational,
      assetFailure: row.type_asset_failure,
      findingEscalation: row.type_finding_escalation,
    },
    bySeverity: {
      low: row.severity_low,
      medium: row.severity_medium,
      high: row.severity_high,
      critical: row.severity_critical,
    },
    operational: {
      open: row.operational_open,
      inProgress: row.operational_in_progress,
      resolved: row.operational_resolved,
    },
    byStatus: toStatusCounts([
      ['REPORTED', row.reported],
      ['CANCELLED', row.cancelled],
      ['CLOSED', row.closed],
    ]),
  };
}

function projectHandovers(row: HandoverKpiRow) {
  return {
    activeBindings: row.active_bindings,
    total: row.total,
    draft: row.draft,
    ready: row.ready,
    acknowledged: row.acknowledged,
    pendingAcknowledgement: row.pending_acknowledgement,
    byStatus: toStatusCounts([
      ['DRAFT', row.draft],
      ['READY', row.ready],
      ['ACKNOWLEDGED', row.acknowledged],
    ]),
  };
}

export async function getSecurityFindingIncidentKpi(
  filters: SecurityFindingIncidentKpiFilters,
  userId: string,
): Promise<PublicSecurityFindingIncidentKpi> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    asOf: new Date().toISOString(),
  };

  // No accessible buildings — return a well-formed zeroed KPI rather
  // than a 403, matching the BE-12M / BE-23F1 reporting convention.
  if (buildingIds.length === 0) {
    return {
      ...base,
      findings: projectFindings(EMPTY_FINDING_KPI_ROW),
      incidents: projectIncidents(EMPTY_INCIDENT_KPI_ROW),
      shiftHandovers: projectHandovers(EMPTY_HANDOVER_KPI_ROW),
    };
  }

  const [findings, incidents, handovers] = await Promise.all([
    securityFindingIncidentKpiRepository.getFindingKpi(
      buildingIds,
      filters,
      start,
      end,
    ),
    securityFindingIncidentKpiRepository.getIncidentKpi(
      buildingIds,
      filters,
      start,
      end,
    ),
    securityFindingIncidentKpiRepository.getHandoverKpi(
      buildingIds,
      filters,
      start,
      end,
    ),
  ]);

  return {
    ...base,
    findings: projectFindings(findings),
    incidents: projectIncidents(incidents),
    shiftHandovers: projectHandovers(handovers),
  };
}

export const securityFindingIncidentKpiService = {
  getSecurityFindingIncidentKpi,
};

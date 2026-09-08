import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  completionRate,
  EMPTY_ASSIGNMENT_ROW,
  EMPTY_HEADCOUNT_ROW,
  round2,
  toNumber,
  workforceKpiRepository,
  type WorkforceAssignmentRow,
  type WorkforceHeadcountRow,
} from './workforce-kpi.repository';
import type {
  PublicWorkforceKpi,
  PublicWorkforceKpiMember,
  WorkforceKpiFilters,
} from './workforce-kpi.types';
import { workforceKpiRange } from './workforce-kpi.validation';

/**
 * BE-23G — Workforce KPI service.
 *
 * Read-only. Building access is asserted per request: an explicit
 * `buildingId` is access-checked, and an omitted one rolls the KPI up
 * across exactly the Buildings the caller can reach, so cross-Building
 * and cross-Client leakage is impossible.
 *
 * This module never mutates BE-03 Workforce or BE-07 Task state — it
 * only reads their authoritative records.
 */

async function resolveScope(
  filters: WorkforceKpiFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = workforceKpiRange(filters);
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

export function projectWorkforceKpiHeadcount(
  headcount: WorkforceHeadcountRow,
  distinctWithAssignments: number,
) {
  return {
    total: headcount.total,
    active: headcount.active,
    inactive: headcount.inactive,
    internal: headcount.internal,
    outsourced: headcount.outsourced,
    contract: headcount.contract,
    withAssignments: distinctWithAssignments,
  };
}

export function projectWorkforceKpiAssignments(row: WorkforceAssignmentRow) {
  return {
    scheduled: row.scheduled,
    completed: row.completed,
    inProgress: row.in_progress,
    open: row.open,
    cancelled: row.cancelled,
    overdue: row.overdue,
    completionRate: completionRate(row.completed, row.scheduled),
    byAssigneeType: {
      workforce: row.assignee_workforce,
      team: row.assignee_team,
    },
  };
}

export function projectWorkforceKpiManHours(row: WorkforceAssignmentRow) {
  const totalHours = round2(toNumber(row.total_hours));
  const measured = row.measured_assignments;
  const people = row.distinct_workforce;
  return {
    totalHours,
    measuredAssignments: measured,
    unmeasuredAssignments: row.unmeasured_assignments,
    averageHoursPerAssignment: measured > 0 ? round2(totalHours / measured) : 0,
    averageHoursPerWorkforce: people > 0 ? round2(totalHours / people) : 0,
  };
}

/**
 * Shared BE-23 overdue boundary. BE-24 read models reuse this helper rather
 * than restating the assignment-overdue grace calculation.
 */
export function workforceKpiDueBefore(
  asOf: Date,
  graceMinutes: number,
): Date {
  return new Date(asOf.getTime() - graceMinutes * 60000);
}

export async function getWorkforceKpi(
  filters: WorkforceKpiFilters,
  userId: string,
): Promise<PublicWorkforceKpi> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);
  const graceMinutes = filters.graceMinutes ?? 0;
  const asOf = new Date();
  const dueBefore = workforceKpiDueBefore(asOf, graceMinutes);

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    graceMinutes,
    asOf: asOf.toISOString(),
  };

  // No accessible buildings — return a well-formed zeroed KPI rather
  // than a 403, matching the BE-23F1 / BE-23F2 reporting convention.
  if (buildingIds.length === 0) {
    return {
      ...base,
      workforce: projectWorkforceKpiHeadcount(EMPTY_HEADCOUNT_ROW, 0),
      assignments: projectWorkforceKpiAssignments(EMPTY_ASSIGNMENT_ROW),
      manHours: projectWorkforceKpiManHours(EMPTY_ASSIGNMENT_ROW),
      byWorkforce: [],
    };
  }

  const [headcount, assignments, byWorkforce]: [
    WorkforceHeadcountRow,
    WorkforceAssignmentRow,
    PublicWorkforceKpiMember[],
  ] = await Promise.all([
    workforceKpiRepository.getWorkforceHeadcount(buildingIds, filters),
    workforceKpiRepository.getWorkforceAssignmentKpi(
      buildingIds,
      filters,
      start,
      end,
      dueBefore,
    ),
    workforceKpiRepository.getWorkforceKpiByMember(
      buildingIds,
      filters,
      start,
      end,
      dueBefore,
    ),
  ]);

  return {
    ...base,
    workforce: projectWorkforceKpiHeadcount(
      headcount,
      assignments.distinct_workforce,
    ),
    assignments: projectWorkforceKpiAssignments(assignments),
    manHours: projectWorkforceKpiManHours(assignments),
    byWorkforce,
  };
}

export const workforceKpiService = {
  getWorkforceKpi,
};

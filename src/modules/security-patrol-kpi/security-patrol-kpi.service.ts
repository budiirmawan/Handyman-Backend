import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  completionRate,
  securityPatrolKpiRepository,
} from './security-patrol-kpi.repository';
import type {
  PublicSecurityPatrolKpi,
  SecurityPatrolKpiFilters,
} from './security-patrol-kpi.types';
import { patrolKpiRange } from './security-patrol-kpi.validation';

/**
 * BE-23F1 — Security Patrol & Activity KPI service.
 *
 * Read-only. Building access is asserted per request: an explicit
 * `buildingId` is access-checked, and an omitted one rolls the KPI up
 * across exactly the Buildings the caller can reach. Cross-Building and
 * cross-Client leakage is therefore impossible.
 *
 * This module never mutates Security domain state — it only reads the
 * BE-12 / BE-07 authoritative records.
 */

async function resolveScope(
  filters: SecurityPatrolKpiFilters,
  userId: string,
): Promise<{ start: Date | null; end: Date | null; buildingIds: string[] }> {
  const range = patrolKpiRange(filters);
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

export async function getSecurityPatrolKpi(
  filters: SecurityPatrolKpiFilters,
  userId: string,
): Promise<PublicSecurityPatrolKpi> {
  const { start, end, buildingIds } = await resolveScope(filters, userId);
  const graceMinutes = filters.graceMinutes ?? 0;
  const asOf = new Date();
  const dueBefore = new Date(asOf.getTime() - graceMinutes * 60000);

  const base = {
    buildingId: filters.buildingId ?? null,
    buildingScope: buildingIds,
    dateFrom: filters.dateFrom ?? null,
    dateTo: filters.dateTo ?? null,
    graceMinutes,
    asOf: asOf.toISOString(),
  };

  // No accessible buildings — return a well-formed zeroed KPI rather
  // than a 403, matching the BE-12M reporting convention.
  if (buildingIds.length === 0) {
    return {
      ...base,
      patrols: {
        scheduled: 0,
        completed: 0,
        inProgress: 0,
        cancelled: 0,
        missed: 0,
        overdue: 0,
        completionRate: 0,
      },
      dailyActivityCount: 0,
      dailyActivity: [],
    };
  }

  const [aggregate, dailyActivity] = await Promise.all([
    securityPatrolKpiRepository.getPatrolKpiAggregate(
      buildingIds,
      filters,
      start,
      end,
      dueBefore,
    ),
    securityPatrolKpiRepository.getPatrolKpiDailyBreakdown(
      buildingIds,
      filters,
      start,
      end,
      dueBefore,
    ),
  ]);

  return {
    ...base,
    patrols: {
      scheduled: aggregate.scheduled,
      completed: aggregate.completed,
      inProgress: aggregate.in_progress,
      cancelled: aggregate.cancelled,
      missed: aggregate.missed,
      overdue: aggregate.overdue,
      completionRate: completionRate(aggregate.completed, aggregate.scheduled),
    },
    dailyActivityCount: dailyActivity.reduce(
      (total, day) => total + day.activityCount,
      0,
    ),
    dailyActivity,
  };
}

export const securityPatrolKpiService = {
  getSecurityPatrolKpi,
};

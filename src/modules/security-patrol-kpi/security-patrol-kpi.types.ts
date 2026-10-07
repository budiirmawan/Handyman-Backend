/**
 * BE-23F1 — Security Patrol & Activity KPI domain types.
 *
 * A read-only reporting KPI projection over the authoritative BE-12
 * Security records (BE-12B patrol_routes, BE-12C
 * patrol_schedule_bindings, BE-12D patrol executions / patrol_point_visits)
 * and the shared BE-07 scheduling store (`generated_tasks`).
 *
 * No new operational tables, no ETL, no warehouse, no materialized
 * views. Every number is derived at query time from the source
 * records, so the Security domain remains the single authority for
 * patrol lifecycle state. This module never writes and never mutates
 * Security domain logic.
 *
 * KPI surface (BE-23F1 scope, nothing more):
 *   - patrol scheduled
 *   - patrol completed
 *   - patrol completion rate
 *   - missed / overdue patrol
 *   - daily activity count
 */

export type SecurityPatrolKpiFilters = {
  /**
   * Optional. When omitted the KPI rolls up across every Building the
   * caller can access; when present the Building is access-asserted.
   */
  buildingId?: string;
  securityPostId?: string;
  patrolRouteId?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC, matching BE-07. */
  dateFrom?: string;
  dateTo?: string;
  /**
   * Minutes of tolerance before a past-due patrol is counted as
   * overdue/missed. Defaults to 0 (strict). Lets an operator model a
   * realistic patrol grace period without changing Security domain rules.
   */
  graceMinutes?: number;
};

/** Per-operational-day KPI breakdown (UTC days, ascending). */
export type PublicSecurityPatrolKpiDay = {
  /** UTC operational date, YYYY-MM-DD. */
  date: string;
  scheduled: number;
  completed: number;
  missed: number;
  overdue: number;
  completionRate: number;
  /**
   * Daily activity count for the day: patrol occurrences scheduled that
   * day plus every recorded BE-12D patrol point visit that day. This is
   * the "how much security activity happened" counter.
   */
  activityCount: number;
};

export type PublicSecurityPatrolKpi = {
  /** Null when the KPI is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the numbers. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  graceMinutes: number;
  /** The evaluation instant used to decide missed / overdue. */
  asOf: string;
  patrols: {
    /** Planned patrol occurrences in range, excluding CANCELLED. */
    scheduled: number;
    completed: number;
    inProgress: number;
    cancelled: number;
    /** Past due, never started. A subset of `overdue`. */
    missed: number;
    /** Past due and still not COMPLETED (includes `missed`). */
    overdue: number;
    /** completed / scheduled as a percentage, 2dp. 0 when scheduled is 0. */
    completionRate: number;
  };
  /** Total activity count across the whole window. */
  dailyActivityCount: number;
  dailyActivity: PublicSecurityPatrolKpiDay[];
};

/**
 * BE-23G — Workforce KPI domain types.
 *
 * A read-only reporting KPI projection over the existing Workforce and
 * Task records, reusing the BE-23 reporting foundation established by
 * BE-23F1 / BE-23F2 (same scope resolution, UTC windows, grace-based
 * overdue rule, zeroed-KPI convention).
 *
 * SOURCES
 *   Workforce    BE-03C `workforce_profiles` scoped to a Building via the
 *                BE-03G `workforce_building_assignments` ACTIVE binding.
 *   Assignments  BE-07 `task_assignments` (ACTIVE) joined to their
 *                `generated_tasks` occurrence, which carries the
 *                authoritative lifecycle + execution timestamps.
 *
 * No new operational tables, no migration, no ETL, no warehouse, no
 * writes. Every number is derived at query time, so BE-03 and BE-07
 * remain the sole authorities for their own state. This module never
 * mutates source domain logic.
 *
 * MAN-HOURS
 * The repository holds no stored man-hour, timesheet, or payroll field —
 * inventing one would be a new source of truth. Man-hours are therefore
 * DERIVED from the authoritative execution window on a completed task
 * (`completed_at - started_at`), summed per assignee. Tasks that were
 * completed without a recorded start contribute no time and are counted
 * separately so the number is never silently understated.
 */

export type WorkforceKpiFilters = {
  /**
   * Optional. Omitted means "roll up across every Building the caller
   * can access"; supplied means the Building is access-asserted.
   */
  buildingId?: string;
  /** BE-03C workforce profile narrowing. */
  workforceId?: string;
  /** BE-03B team narrowing (matches TEAM assignments and team members). */
  teamId?: string;
  /** BE-03C workforce_type narrowing: INTERNAL | OUTSOURCED | CONTRACT. */
  workforceType?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC, matching BE-07. */
  dateFrom?: string;
  dateTo?: string;
  /**
   * Minutes of tolerance before a past-due assignment counts as overdue.
   * Defaults to 0 (strict), mirroring the BE-23F1 patrol KPI.
   */
  graceMinutes?: number;
};

/** BE-03C headcount, scoped to the Building set. */
export type PublicWorkforceHeadcountKpi = {
  total: number;
  active: number;
  inactive: number;
  internal: number;
  outsourced: number;
  contract: number;
  /** Distinct workforce profiles actually holding an assignment in range. */
  withAssignments: number;
};

/** BE-07 assignment lifecycle counters. */
export type PublicWorkforceAssignmentKpi = {
  /** Assignments in range, excluding CANCELLED occurrences. */
  scheduled: number;
  completed: number;
  inProgress: number;
  open: number;
  cancelled: number;
  /** Past due and not completed. */
  overdue: number;
  /** completed / scheduled as a percentage, 2dp. 0 when scheduled is 0. */
  completionRate: number;
  byAssigneeType: {
    workforce: number;
    team: number;
  };
};

/** Derived man-hour summary over completed assignments. */
export type PublicWorkforceManHourKpi = {
  /** Sum of (completed_at - started_at) across measurable completions. */
  totalHours: number;
  /** Completed assignments that carried both a start and a completion. */
  measuredAssignments: number;
  /** Completed but with no recorded start — contribute zero hours. */
  unmeasuredAssignments: number;
  /** totalHours / measuredAssignments, 2dp. 0 when nothing measurable. */
  averageHoursPerAssignment: number;
  /** totalHours / distinct assigned workforce, 2dp. */
  averageHoursPerWorkforce: number;
};

/** Per-workforce man-hour and completion breakdown, descending by hours. */
export type PublicWorkforceKpiMember = {
  workforceId: string;
  employeeCode: string;
  fullName: string;
  workforceType: string;
  status: string;
  scheduled: number;
  completed: number;
  overdue: number;
  completionRate: number;
  totalHours: number;
};

export type PublicWorkforceKpi = {
  /** Null when the KPI is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the numbers. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  graceMinutes: number;
  /** The evaluation instant used to decide overdue. */
  asOf: string;
  workforce: PublicWorkforceHeadcountKpi;
  assignments: PublicWorkforceAssignmentKpi;
  manHours: PublicWorkforceManHourKpi;
  byWorkforce: PublicWorkforceKpiMember[];
};

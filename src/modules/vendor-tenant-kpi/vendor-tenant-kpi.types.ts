/**
 * BE-23H — Vendor / Tenant KPI domain types.
 *
 * A read-only reporting KPI projection over the existing Vendor and
 * Tenant records, reusing the BE-23 reporting foundation established by
 * BE-23F1 / BE-23F2 / BE-23G (same scope resolution, UTC windows,
 * grace-based overdue rule, zeroed-KPI convention).
 *
 * SOURCES
 *   Vendor work    BE-15B `vendor_works` joined to its BE-15A
 *                  `vendor_assignments` row and the BE-06A `vendors`
 *                  master. The vendor-work lifecycle
 *                  (NOT_STARTED / IN_PROGRESS / ON_HOLD / COMPLETED)
 *                  is authoritative on `vendor_works.status`.
 *   Tenant service BE-14E `tenant_service_requests`, whose own status is
 *                  OPEN / CANCELLED / CONVERTED. Fulfilment lives on the
 *                  linked BE-08 Work Order, so completion is read from
 *                  there rather than invented on the request.
 *
 * No new operational tables, no migration, no ETL, no warehouse, no
 * writes. Every number is derived at query time, so BE-06 / BE-15 /
 * BE-14 / BE-08 remain the sole authorities for their own state. This
 * module never mutates source domain logic.
 *
 * OVERDUE
 * Neither `vendor_works` nor `vendor_assignments` carries a due-date
 * column, and BE-23H must not add one — that would be a new source of
 * truth in a source domain. Vendor overdue is therefore derived from
 * ELAPSED AGE: a vendor work still not COMPLETED whose assignment was
 * raised more than `overdueAfterDays` ago is overdue. The threshold is
 * an explicit, caller-supplied reporting parameter, never a stored
 * business rule.
 */

export type VendorTenantKpiFilters = {
  /**
   * Optional. Omitted means "roll up across every Building the caller
   * can access"; supplied means the Building is access-asserted.
   */
  buildingId?: string;
  /** BE-06A vendor narrowing. */
  vendorId?: string;
  /** BE-14A tenant company narrowing (tenant KPI only). */
  tenantCompanyId?: string;
  /** BE-14E request_type narrowing (tenant KPI only). */
  requestType?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC, matching BE-07. */
  dateFrom?: string;
  dateTo?: string;
  /**
   * Age in days after which an unfinished vendor work counts as overdue.
   * Defaults to 7. Purely a reporting threshold.
   */
  overdueAfterDays?: number;
};

/** BE-15B vendor work lifecycle counters. */
export type PublicVendorWorkKpi = {
  /** Vendor works in range. */
  total: number;
  notStarted: number;
  inProgress: number;
  onHold: number;
  completed: number;
  /** Not yet COMPLETED. */
  outstanding: number;
  /** Unfinished and older than the overdue threshold. */
  overdue: number;
  /** completed / total as a percentage, 2dp. 0 when total is 0. */
  completionRate: number;
  /** Average completed_at - started_at, in hours, 2dp. */
  averageCompletionHours: number;
};

/** Per-vendor performance summary, ordered by descending completion rate. */
export type PublicVendorPerformanceRow = {
  vendorId: string;
  vendorCode: string;
  vendorName: string;
  vendorStatus: string;
  total: number;
  completed: number;
  outstanding: number;
  overdue: number;
  completionRate: number;
  averageCompletionHours: number;
};

/** BE-14E tenant service request counters. */
export type PublicTenantServiceKpi = {
  /** Requests raised in range. */
  total: number;
  /** Intake status, authoritative on the request itself. */
  open: number;
  converted: number;
  cancelled: number;
  /**
   * Fulfilment, read from the linked BE-08 Work Order. A request is
   * `completed` when its Work Order reached COMPLETED or CLOSED.
   */
  completed: number;
  /**
   * Still awaiting fulfilment: OPEN intake, or CONVERTED whose Work
   * Order has not yet completed. Excludes CANCELLED.
   */
  outstanding: number;
  /** completed / (total - cancelled) as a percentage, 2dp. */
  completionRate: number;
  byPriority: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
};

export type PublicVendorTenantKpi = {
  /** Null when the KPI is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the numbers. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  overdueAfterDays: number;
  /** The evaluation instant used to decide overdue. */
  asOf: string;
  vendorWork: PublicVendorWorkKpi;
  vendorPerformance: PublicVendorPerformanceRow[];
  tenantService: PublicTenantServiceKpi;
};

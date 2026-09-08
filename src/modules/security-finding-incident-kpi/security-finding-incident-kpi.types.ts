/**
 * BE-23F2 — Security Finding / Incident / Handover KPI domain types.
 *
 * A read-only reporting KPI projection over three authoritative sources,
 * reusing the BE-23 reporting foundation established by BE-23F1:
 *
 *   Findings   BE-09 `findings` scoped to Security by the BE-12H
 *              `security_finding_links` binding.
 *   Incidents  BE-21A `incidents`, narrowed to the Security-relevant ones
 *              (BE-21B operational incidents categorised SECURITY, plus
 *              BE-21D finding escalations whose Finding carries a BE-12H
 *              Security binding).
 *   Handovers  BE-10J `shift_handovers` surfaced through the BE-12G
 *              `security_shift_handover_bindings` ACTIVE binding.
 *
 * No new operational tables, no migration, no ETL, no warehouse, no
 * writes. Every number is derived at query time, so BE-09 / BE-21 /
 * BE-12 remain the sole authorities for their own lifecycles. This
 * module never mutates source domain state.
 *
 * Patrol KPI is deliberately absent — it is BE-23F1 and is not repeated
 * here.
 */

export type SecurityFindingIncidentKpiFilters = {
  /**
   * Optional. Omitted means "roll up across every Building the caller
   * can access"; supplied means the Building is access-asserted.
   */
  buildingId?: string;
  /**
   * Applies to Findings and Shift Handovers, which both carry a Security
   * Post binding. Incidents have no Post of their own, so when this
   * filter is set the Incident counters narrow to escalations reachable
   * through a Security Finding bound to that Post.
   */
  securityPostId?: string;
  patrolRouteId?: string;
  /** BE-21A incident_type narrowing. */
  incidentType?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC, matching BE-07. */
  dateFrom?: string;
  dateTo?: string;
};

/** Generic status -> count pair, ordered by descending count then status. */
export type PublicKpiStatusCount = {
  status: string;
  count: number;
};

/** BE-09 Finding lifecycle counters, scoped to Security findings. */
export type PublicSecurityFindingKpi = {
  total: number;
  open: number;
  assigned: number;
  inProgress: number;
  pendingReview: number;
  rejected: number;
  reworkRequired: number;
  resubmitted: number;
  verified: number;
  closed: number;
  cancelled: number;
  /** Still requiring operational attention (not verified/closed/cancelled). */
  outstanding: number;
  byStatus: PublicKpiStatusCount[];
};

/** BE-21A Incident counters, scoped to Security-relevant incidents. */
export type PublicSecurityIncidentKpi = {
  total: number;
  reported: number;
  cancelled: number;
  closed: number;
  byType: {
    operational: number;
    assetFailure: number;
    findingEscalation: number;
  };
  bySeverity: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  /** BE-21B operational handling progression, distinct from record status. */
  operational: {
    open: number;
    inProgress: number;
    resolved: number;
  };
  byStatus: PublicKpiStatusCount[];
};

/** BE-10J handover lifecycle counters, seen through the BE-12G binding. */
export type PublicSecurityHandoverKpi = {
  /** ACTIVE Security bindings in scope (one per handover, by schema). */
  activeBindings: number;
  total: number;
  draft: number;
  ready: number;
  acknowledged: number;
  /** Prepared but not yet acknowledged — the operational backlog. */
  pendingAcknowledgement: number;
  byStatus: PublicKpiStatusCount[];
};

export type PublicSecurityFindingIncidentKpi = {
  /** Null when the KPI is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the numbers. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  /** The instant the projection was taken. */
  asOf: string;
  findings: PublicSecurityFindingKpi;
  incidents: PublicSecurityIncidentKpi;
  shiftHandovers: PublicSecurityHandoverKpi;
};

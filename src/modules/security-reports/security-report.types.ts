/**
 * BE-12M — Security Reporting Dataset domain types.
 *
 * Read-only reporting projections over the authoritative BE-12
 * operational records (security-posts, patrol-routes,
 * patrol-schedule-bindings, patrol-executions, patrol-checklist-bindings,
 * security-shift-handover-bindings, security-finding-links,
 * security-incident-readiness, security-visitor-bindings, security-keys,
 * security-key-custody, security-lost-found, security-lost-found-history)
 * plus shared sources (findings, generated_tasks, shift_handovers,
 * checklist_executions, workforce_profiles, teams).
 *
 * No ETL, no warehouse, no duplicated operational tables. Every dataset
 * is a direct query over the source records and surfaces their
 * authoritative current status.
 */

export type SecurityReportFilters = {
  /**
   * Optional for the summary endpoint (which may roll up across
   * every accessible building). The dataset endpoints require a
   * `buildingId` and assert it at the service boundary.
   */
  buildingId?: string;
  securityPostId?: string;
  patrolRouteId?: string;
  /** ISO date/datetime; day windows are UTC, matching BE-07 conventions. */
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  custodyStatus?: string;
  category?: string;
  workforceId?: string;
  teamId?: string;
};

/* ------------------------------------------------------------------ */
/*  Summary                                                            */
/* ------------------------------------------------------------------ */

export type PublicSecuritySummary = {
  buildingId: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  buildingScope: string[];
  posts: {
    total: number;
    active: number;
    inactive: number;
  };
  patrolRoutes: {
    total: number;
    active: number;
    inactive: number;
  };
  patrols: {
    scheduled: number;
    inProgress: number;
    completed: number;
    cancelled: number;
  };
  checklists: {
    openExecutions: number;
    completedExecutions: number;
  };
  findings: {
    open: number;
    verified: number;
    closed: number;
  };
  shiftHandovers: {
    activeBindings: number;
    draftHandovers: number;
    readyHandovers: number;
    acknowledgedHandovers: number;
  };
  incidentReadiness: {
    notReady: number;
    partial: number;
    ready: number;
    activeBindings: number;
  };
  visitorBindings: {
    active: number;
    inactive: number;
  };
  keyControl: {
    available: number;
    issued: number;
    overdue: number;
    lost: number;
    inactive: number;
    openCustodyRows: number;
  };
  lostFound: {
    found: number;
    inCustody: number;
    claimed: number;
    returned: number;
    disposed: number;
    closed: number;
  };
};

/* ------------------------------------------------------------------ */
/*  Datasets                                                           */
/* ------------------------------------------------------------------ */

export type PublicPatrolDatasetRow = {
  taskId: string;
  /**
   * R10 PART 14B — the ACTIVE `patrol_schedule_bindings` row this task was joined through.
   *
   * The patrol dataset joins `generated_tasks` to its bindings on `schedule_definition_id`
   * ALONE. `patrol_schedule_bindings_active_unique` is unique on
   * `(patrol_route_id, schedule_definition_id) WHERE status = 'ACTIVE'` — NOT on
   * `schedule_definition_id` by itself — but CR-BE-RN16-PATROL-FIELD-01 PART 00 (migration
   * 0354) added `patrol_schedule_bindings_schedule_active_unique` on
   * `(schedule_definition_id) WHERE status = 'ACTIVE'`, so a schedule definition now holds
   * at most ONE ACTIVE binding and one `taskId` resolves to exactly one patrol route. This
   * query still has no DISTINCT, GROUP BY, ROW_NUMBER or LATERAL selector and still elects
   * no primary, current or latest binding: it never had to choose, and it never chooses now.
   *
   * The truthful row identity is `(taskId, patrolScheduleBindingId)`, and this field exists
   * to make that identity expressible. It names the actual joined binding for THIS row only;
   * it is not a selection among bindings and implies no precedence.
   *
   * Non-nullable: the binding is reached through an INNER JOIN filtered on
   * `psb.status = 'ACTIVE'`, and `patrol_schedule_bindings.id` is a UUID PRIMARY KEY, so
   * every row that exists has a binding id. Same derivation as `patrolRouteId` below.
   */
  patrolScheduleBindingId: string;
  patrolRouteId: string;
  patrolRouteCode: string;
  patrolRouteName: string;
  securityPostId: string | null;
  securityPostCode: string | null;
  securityPostName: string | null;
  status: string;
  occurrenceAt: string;
  startedAt: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
};

export type PublicSecurityPostDatasetRow = {
  securityPostId: string;
  code: string;
  name: string;
  postType: string;
  status: string;
  patrolRouteCount: number;
  openPatrolCount: number;
};

export type PublicSecurityFindingDatasetRow = {
  linkId: string;
  findingId: string;
  findingNumber: string;
  findingTitle: string;
  findingStatus: string;
  linkStatus: string;
  sourcePostId: string | null;
  sourcePostCode: string | null;
  sourceRouteId: string | null;
  sourceRouteCode: string | null;
  reportedAt: string;
};

export type PublicShiftHandoverDatasetRow = {
  bindingId: string;
  shiftHandoverId: string;
  startSecurityPostId: string | null;
  startSecurityPostCode: string | null;
  patrolRouteId: string | null;
  patrolRouteCode: string | null;
  bindingStatus: string;
  handoverStatus: string;
  handoverCreatedAt: string;
};

export type PublicIncidentReadinessDatasetRow = {
  bindingId: string;
  buildingId: string;
  securityPostId: string | null;
  securityPostCode: string | null;
  category: string;
  status: string;
  teamId: string | null;
  teamName: string | null;
  primaryWorkforceId: string | null;
  primaryWorkforceName: string | null;
  updatedAt: string;
};

export type PublicVisitorBindingDatasetRow = {
  bindingId: string;
  buildingId: string;
  securityPostId: string | null;
  securityPostCode: string | null;
  externalVisitReference: string;
  securityWorkforceId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type PublicKeyControlDatasetRow = {
  keyId: string;
  code: string;
  name: string;
  status: string;
  securityPostId: string | null;
  securityPostCode: string | null;
  hasOpenCustody: boolean;
  openCustodyWorkforceId: string | null;
  updatedAt: string;
};

export type PublicLostFoundDatasetRow = {
  recordId: string;
  itemCode: string;
  itemName: string;
  custodyStatus: string;
  securityPostId: string | null;
  securityPostCode: string | null;
  foundAt: string;
  hasActiveClaim: boolean;
  updatedAt: string;
};

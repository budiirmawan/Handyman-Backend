/**
 * CR-BE-REPORT-READ-03 PART 01 — Work Order Register read contract types.
 *
 * READ MODEL ONLY. One flat row per authoritative `work_orders` row, joining
 * existing records (asset, functional location, ACTIVE assignment, latest
 * COMPLETED verification review, evidence count, finding count, history
 * count) for Reporting consumption.
 *
 * WHAT THIS CONTRACT IS NOT
 *   - It creates no business entity, lifecycle status, or persistence.
 *   - It performs no business calculation and no inference: every status,
 *     priority, decision, and timestamp is the authoritative value verbatim.
 *     In particular it never infers scheduled/due dates, SLA, overdue,
 *     risk, open-finding state, rework, closure, or verification from
 *     combinations of other records.
 *   - Work Orders have no generic `sourceType`/`sourceId` (unlike Findings);
 *     the only origin reference is `workRequestId`, exposed verbatim.
 *     No fabricated sourceType is introduced.
 *   - No checklist or execution detail — checklist binding/execution is
 *     deferred to a later PART when a direct Work Order binding exists.
 *   - No evidence gallery. Only an ACTIVE evidence COUNT over the Work Order
 *     root (execution_type='WORK_ORDER'); no URLs/files.
 *
 * Grain: exactly one row per `work_orders` row in scope. Optional LEFT joins
 * never remove the base row and never fan out (singleton relations are
 * schema-enforced to 0..1; the ACTIVE work_order_assignments partial unique
 * index guarantees at most one ACTIVE row per Work Order; multi-row
 * aggregates use COUNT/LATERAL LIMIT 1).
 */

export type WorkOrderRegisterFilters = {
  /**
   * Optional. Omitted means "roll up across every Building the caller
   * can access" (BE-23H convention); supplied means the Building is
   * existence-checked and access-asserted.
   */
  buildingId?: string;
  /** Authoritative Work Order status verbatim. */
  status?: string;
  /** work_type (data-driven code string) verbatim. */
  workType?: string;
  /** Priority verbatim (LOW/MEDIUM/HIGH/CRITICAL). */
  priority?: string;
  /** BAST cardinality policy verbatim. */
  bastRequirement?: string;
  /** Asset id exact match (wo.asset_id). */
  assetId?: string;
  /**
   * Responsible-workforce narrowing, applied only when the ACTIVE
   * assignment is WORKFORCE with that workforce_profile_id.
   */
  assignedUserId?: string;
  /** ACTIVE TEAM assignment narrowing. */
  assignedTeamId?: string;
  /** ACTIVE VENDOR/VENDOR_WORKFORCE assignment narrowing. */
  vendorId?: string;
  /**
   * Latest COMPLETED verification decision (APPROVED/REJECTED/
   * REWORK_REQUIRED per the shared reviews authority); matched against
   * the latest COMPLETED review only (ORDER BY reviewed_at DESC,
   * created_at DESC, id DESC LIMIT 1).
   */
  verificationDecision?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC half-open. */
  dateFrom?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC half-open. */
  dateTo?: string;
};

/** One flat Work Order Register row. Every status/decision is verbatim; every link nullable. */
export type PublicWorkOrderRegisterRow = {
  /* Identity */
  workOrderId: string;
  workOrderNumber: string;
  title: string;
  description: string | null;
  status: string;

  /* Context */
  clientId: string;
  buildingId: string;
  assetId: string | null;
  assetCode: string | null;
  assetName: string | null;
  functionalLocationId: string | null;
  functionalLocationCode: string | null;
  functionalLocationName: string | null;

  /* Classification / origin */
  workType: string;
  priority: string;
  bastRequirement: string;
  workRequestId: string | null;

  /* Actual lifecycle timestamps */
  createdAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;

  /* Assignment (ACTIVE only — mirrors BE-08E one-ACTIVE invariant) */
  assigneeType: string | null;
  assignedWorkforceProfileId: string | null;
  assignedTeamId: string | null;
  assignedVendorId: string | null;
  assignedByUserId: string | null;
  assignmentAssignedAt: string | null;

  /* Evidence — ACTIVE count only for execution_type = 'WORK_ORDER' */
  evidenceCount: number;

  /* Findings — total Findings linked via source_type='WORK_ORDER' only */
  findingCount: number;

  /* Verification — latest COMPLETED review */
  verificationReviewId: string | null;
  verificationReviewStatus: string | null;
  verificationDecision: string | null;
  verificationReviewerUserId: string | null;
  verificationReviewedAt: string | null;

  /* Completion */
  completedByUserId: string | null;
  completionSummary: string | null;
  completionNotes: string | null;

  /* History */
  historyAvailable: boolean;
  historyCount: number;
};

export type PublicWorkOrderRegister = {
  /** Null when the register is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the rows. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  /** The evaluation instant. */
  asOf: string;
  rows: PublicWorkOrderRegisterRow[];
};

/**
 * CR-BE-REPORT-READ-02 PART 01 — Finding Register read contract types.
 *
 * READ MODEL ONLY. One flat row per authoritative `findings` row, joining
 * existing records (classification, severity, ACTIVE assignment, latest
 * review, current REQUESTED rework, evidence count, history count, optional
 * WORK_ORDER source reference) for Reporting consumption.
 *
 * WHAT THIS CONTRACT IS NOT
 *   - It creates no business entity, lifecycle status, or persistence.
 *   - It performs no business calculation and no inference: every status,
 *     decision, and timestamp is the authoritative value verbatim.
 *     In particular it never infers closure, verification state, rework
 *     completion, source status, risk, severity semantics, overdue, or
 *     SLA from the presence or combination of other records.
 *   - No source orchestration engine. Source reference enrichment is
 *     provided only for WORK_ORDER (bounded, authoritative, schema-bound
 *     `f.source_type = 'WORK_ORDER' AND wo.id = f.source_id`); all other
 *     source types expose `sourceType` + `sourceId` only.
 *   - No evidence gallery. Only an ACTIVE evidence COUNT over the Finding
 *     root is exposed (execution_type='FINDING'); no URLs/files.
 *
 * Grain: exactly one row per `findings` row in scope. Optional LEFT joins
 * never remove the base row and never fan out (singleton relations are
 * schema-enforced to 0..1; multi-row aggregates use COUNT/LATERAL LIMIT 1).
 */

export type FindingRegisterFilters = {
  /**
   * Optional. Omitted means "roll up across every Building the caller
   * can access" (BE-23H convention); supplied means the Building is
   * existence-checked and access-asserted.
   */
  buildingId?: string;
  /** Authoritative finding status verbatim. */
  status?: string;
  /** Classification id (exact match). */
  classificationId?: string;
  /** Severity id (exact match). */
  severityId?: string;
  /** Source type verbatim (FINDING_SOURCE_TYPES). */
  sourceType?: string;
  /**
   * Source record id (exact match against `findings.source_id`).
   *
   * INDEPENDENT of `sourceType`. Supplying `sourceId` never infers,
   * implies, or constrains `sourceType`, and vice versa; when both are
   * supplied they are conjunctive (`sourceType AND sourceId`) and both
   * must match the same row.
   *
   * Narrowing-only: it can reduce the authorized row set but never widen
   * it. It never replaces, weakens, bypasses, or alters the unconditional
   * `f.building_id = ANY(...)` authorized-building predicate, and it
   * performs no polymorphic source traversal — the referenced source
   * record is never joined, resolved, or dereferenced by this filter.
   */
  sourceId?: string;
  /**
   * Responsible-workforce narrowing, applied only when the ACTIVE
   * assignment is WORKFORCE with that workforce_profile_id.
   */
  assignedUserId?: string;
  /**
   * Latest review decision (APPROVED/REJECTED/REWORK_REQUIRED per the
   * shared reviews authority); matched against the most recent review
   * (ORDER BY created_at DESC, id LIMIT 1) regardless of status, because
   * the reviews authority uses that ordering for its "current"
   * (pending-current) selection.
   */
  verificationDecision?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC half-open. */
  dateFrom?: string;
  /** ISO date (YYYY-MM-DD) or datetime; day windows are UTC half-open. */
  dateTo?: string;
};

/** One flat Finding Register row. Every status/decision is verbatim; every link nullable. */
export type PublicFindingRegisterRow = {
  /* Identity */
  findingId: string;
  findingNumber: string;
  title: string;
  description: string | null;
  status: string;

  /* Classification */
  classificationId: string | null;
  classificationCode: string | null;
  classificationName: string | null;
  severityId: string | null;
  severityCode: string | null;
  severityName: string | null;
  severityRank: number | null;

  /* Source */
  sourceType: string | null;
  sourceId: string | null;
  /**
   * Bounded WORK_ORDER enrichment: work_order_number when
   * `sourceType = 'WORK_ORDER'` and the WO row exists. Null for all
   * other source types or when the reference row is missing.
   */
  sourceReferenceNumber: string | null;

  /* Context */
  clientId: string;
  buildingId: string;
  /**
   * Asset / Functional Location are exposed ONLY when directly resolvable
   * from the WORK_ORDER source binding (`sourceType='WORK_ORDER'`);
   * null otherwise. No polymorphic source traversal.
   */
  assetId: string | null;
  functionalLocationId: string | null;

  /* Reporting / lifecycle timestamps */
  reportedByUserId: string;
  reportedAt: string;
  createdAt: string;
  stateChangedAt: string;

  /* Assignment (ACTIVE only — mirrors management-critical-findings) */
  assigneeType: string | null;
  assignedWorkforceProfileId: string | null;
  assignedTeamId: string | null;
  assignedVendorId: string | null;
  assignedByUserId: string | null;
  assignedAt: string | null;

  /* Evidence — ACTIVE count only for execution_type = 'FINDING' */
  evidenceCount: number;

  /* Rework — current REQUESTED rework (findCurrent semantics), COUNT(*) total */
  reworkCount: number;
  latestReworkId: string | null;
  latestReworkStatus: string | null;
  latestReworkRequestedAt: string | null;

  /* Verification — most recent review (pending or completed) */
  verificationReviewId: string | null;
  verificationReviewStatus: string | null;
  verificationDecision: string | null;
  verificationReviewerUserId: string | null;
  verificationReviewedAt: string | null;

  /* Closure */
  closedAt: string | null;
  closedByUserId: string | null;
  closureNotes: string | null;

  /* History */
  historyAvailable: boolean;
  historyCount: number;
};

export type PublicFindingRegister = {
  /** Null when the register is a multi-building rollup. */
  buildingId: string | null;
  /** Every Building actually included in the rows. */
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  /** The evaluation instant. */
  asOf: string;
  rows: PublicFindingRegisterRow[];
};

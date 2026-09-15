import type { FindingAssigneeType } from '../finding-assignments/finding-assignment.types';
import type { FindingStatus } from '../findings/finding.types';
import type { OperationalDetailEngine } from '../operational-detail-reporting/operational-detail-reporting.types';

/**
 * R08 PART 02B — Operational Detail Finding child projection (types).
 *
 * READ MODEL ONLY. Backend-owned, read-only, internal (no HTTP endpoint).
 *
 * GRAIN
 *   ONE ROW per `findings.id`.
 *   PARENT KEY = (engine, executionId) where engine is the R07 vocabulary
 *   CHECKLIST_EXECUTION | FORM_INSTANCE (reused, never redeclared) and
 *   executionId is `findings.source_id` — the authoritative
 *   `checklist_executions.id` / `form_instances.id`.
 *
 *   There is NO detail attribution: `findings` stores no checklist_item_id,
 *   definition_item_id, version_field_id, form_field_id, response_id,
 *   occurrence_id or occurrence_index (verified across every migration that
 *   alters the table: 0091, 0092, 0094, 0096, 0097). No item / field / response
 *   / occurrence inference is performed or expressible.
 *
 * POPULATION (R08 PART 02A §8, §10)
 *   `f.source_type = <engine> AND f.source_id = parent.id` is structural, so:
 *     - SOURCELESS findings (source_type IS NULL, permitted by
 *       `finding_source_complete`) can never match — NULL is not equal to a
 *       bound engine literal.
 *     - WORK_ORDER-sourced findings can never match: WORK_ORDER is a valid
 *       stored `findings.source_type` but is NOT an R08 engine.
 *   No application-level filter is needed for either exclusion.
 *
 * TWO BUILDING FACTS — deliberately distinct (R08 PART 02A §4, §5, §6)
 *   `parentBuildingId` = the R04 authoritative building RESOLVED for the parent
 *   execution/instance. `findingBuildingId` = `findings.building_id` verbatim.
 *
 *   They MAY LEGITIMATELY DIFFER, and that is not an error: the historical
 *   write-time building authority was narrower than R04's. For FORM_INSTANCE the
 *   finding-source resolver returns no building at all, so the bind-time
 *   building comparison never runs; for CHECKLIST_EXECUTION it resolves only via
 *   generated_task → generated_tasks.building_id, whereas R04 resolves a
 *   seven-path COALESCE in which generated_tasks is LAST. A correctly created,
 *   correctly bound finding can therefore carry a different building than R04
 *   resolves for its parent.
 *
 *   Consequently `f.building_id = parentBuildingId` is NOT an authoritative
 *   invariant and is NOT required. Requiring it would silently drop legitimate
 *   lineage. Both facts are exposed as stored truths so a consumer can SEE the
 *   relationship, and NO policy interpretation is derived: there is no
 *   buildingMismatch, isBuildingConsistent, sameBuilding or equivalent field,
 *   and none may be added.
 *
 *   SECURITY (both must hold, over the SAME authorized set):
 *     parentBuildingId  ∈ authorizedBuildingIds   (R04 resolution; NULL → the
 *                                                  parent is excluded, fail-closed)
 *     findingBuildingId ∈ authorizedBuildingIds   (the finding's own isolation
 *                                                  column, the R02 convention)
 *   A row where only ONE of the two buildings is authorized MUST NOT be
 *   returned. Because both are required to be inside the caller's scope, both
 *   fields are non-nullable in this contract — a returned row can never carry a
 *   NULL building.
 *
 * CLIENT CONSISTENCY (R08 PART 02A §4 — decision A, fail-closed)
 *   `findings.source_id` has NO FOREIGN KEY and nothing in the database ties
 *   `findings.client_id` to the parent execution's client, so the invariant is
 *   enforced STRUCTURALLY IN SQL as part of the join predicate
 *   (`f.client_id = parent.client_id`). A mismatched-client finding is EXCLUDED
 *   by construction — never included-and-flagged, never an error, never
 *   post-filtered, and no caller-supplied clientId is ever consulted.
 *
 * VISIBILITY (R08 PART 02A §7 — decision A)
 *   This child is execution LINEAGE, not an "open findings" widget. The DEFAULT
 *   read applies NO status predicate, so all ten stored statuses are visible,
 *   including the terminal CLOSED and CANCELLED. `status` is an OPTIONAL LITERAL
 *   filter validated against the findings module's own vocabulary
 *   (`isFindingStatus`) — no competing enum is declared here. No derived
 *   lifecycle field exists or may be added: no isOpen, isClosed, isTerminal,
 *   activeFinding, openFinding, and no OPEN/non-OPEN partition (none is stored;
 *   FINDING_TRANSITIONS is a code-level state machine, not a column).
 *
 * CLASSIFICATION / SEVERITY — IDs ONLY (R08 PART 02A §10 — decision A)
 *   `classificationId` and `severityId` are stable stored finding facts. Their
 *   code / name / rank / status are LIVE reference data owned by R02
 *   FINDING_REGISTER, which already LEFT JOINs finding_classifications and
 *   finding_severities. This child does NOT join them and does NOT expose
 *   classificationCode / classificationName / severityCode / severityName /
 *   severityRank: duplicating them would create a second live-reference
 *   authority for identical truth. NO historical label claim is made or implied
 *   — labels are not snapshotted on `findings`.
 *
 * ACTIVE ASSIGNMENT — inline, fan-out-free (R08 PART 02A §11 — decision B)
 *   `finding_active_assignment_unique` is a PARTIAL UNIQUE index on
 *   (finding_id) WHERE status = 'ACTIVE', so the schema guarantees 0..1 ACTIVE
 *   assignment per finding. The LEFT JOIN therefore cannot duplicate the finding
 *   grain and needs no GROUP BY / DISTINCT. All seven fields are NULL when the
 *   finding is unassigned. `assignee_type = 'VENDOR_WORKFORCE'` is represented
 *   by vendorId + workforceProfileId together (the `finding_assignment_target`
 *   CHECK makes the four shapes mutually exclusive and complete) — there is NO
 *   vendorWorkforceId column anywhere in the schema and none is invented.
 *   No display-name join (users / workforce_profiles / teams / vendors) exists in
 *   this PART, and no assignment HISTORY (INACTIVE rows) is exposed.
 *
 * EXCLUDED BY CONTRACT (R08 PART 02A §12–§14, §18–§20)
 *   NO rework: no finding_rework_cycles join, no reworkCount / latestReworkId /
 *   latestReworkStatus / latestReworkRequestedAt — R08 PART 03 owns Finding
 *   Rework lineage.
 *   NO review: no reviews join, no verificationReviewId / verificationStatus /
 *   verificationDecision / verificationReviewerUserId / verificationReviewedAt.
 *   Finding reviews are finding-level and are NOT R07 execution verification;
 *   PENDING_REVIEW / VERIFIED / REJECTED are exposed as verbatim statuses only
 *   and never imply that a review exists or decided anything.
 *   NO history: no operational_events join, no historyCount / historyAvailable.
 *   NO evidence: no evidence_submissions join, no evidenceCount.
 *   NO WORK_ORDER enrichment imported from R02: assetId and functionalLocationId
 *   are NOT `findings` columns — R02 obtains them from `work_orders` only when
 *   source_type = 'WORK_ORDER', which this projection excludes, so they would be
 *   permanently-null columns implying a fact the projection cannot know.
 *   priority and dueDate are not stored on `findings` at all.
 *
 * ATTRIBUTION (R08 PART 02A §19)
 *   reportedByUserId = REPORTED BY. closedByUserId = CLOSED BY.
 *   assignedByUserId = ASSIGNED BY. The assignee target = ASSIGNED TO.
 *   NONE of these is an executor: no field may be exposed or labelled Executed
 *   By / Performed By / Actual Executor / Completed By / Captured By. The
 *   execution's actor belongs to R07's execution-detail authority.
 *
 * R02 NON-DUPLICATION (R08 PART 02A §21)
 *   R02 FINDING_REGISTER is the finding-CENTRIC operational register: isolated
 *   by `findings.building_id` alone, all source types with WORK_ORDER
 *   enrichment, live classification/severity labels, ACTIVE assignment, latest
 *   review, rework summary, finding-level evidence count and history count,
 *   date window on `f.reported_at`, and NO pagination.
 *   This child is the EXECUTION-LINEAGE view: population restricted to findings
 *   whose source is an R08 engine AND whose parent execution resolves inside the
 *   R07 reporting building scope under R04 authority AND whose own building is
 *   inside that same scope; keyed by (engine, executionId); paginated at finding
 *   grain; half-open window over the PARENT's created_at; minimal stored facts
 *   plus the 0..1 ACTIVE assignment.
 *   Same underlying Finding authority, different governed projection, grain,
 *   population rule and use-case. There is NO second finding lifecycle
 *   authority: status vocabulary, transition legality and closure semantics are
 *   read verbatim from the findings module. R02 is NOT modified to reconcile
 *   with this child, and this child does not reproduce R02's enrichment.
 */

/** One finding lineage row. Every field is copied verbatim; NULLs preserved. */
export type PublicOperationalDetailFindingRow = {
  /* Identity + parent key */
  findingId: string; // findings.id — the row grain and only locator
  engine: OperationalDetailEngine; // = source_type, R07 vocabulary reused
  executionId: string; // = source_id, authoritative parent execution/instance
  clientId: string; // client-consistency anchor; a scope FACT, never a caller filter

  /* TWO distinct building facts — see the contract header. Never collapsed,
     never compared, never interpreted. Both are guaranteed to be inside the
     caller's authorized building set, so neither is nullable here. */
  parentBuildingId: string; // R04 authoritative building RESOLVED for the parent
  findingBuildingId: string; // findings.building_id verbatim — the isolation column

  /* Core stored facts */
  findingNumber: string; // NOT NULL, UNIQUE per client
  title: string; // NOT NULL
  description: string | null;

  /* Reference IDs ONLY — live labels are R02's authority, not joined here */
  classificationId: string | null;
  severityId: string | null;

  /* Lifecycle — verbatim, no derived state. All ten statuses are representable
     and visible by default, including terminal CLOSED and CANCELLED. */
  status: FindingStatus;
  stateChangedAt: string; // NOT NULL

  /* Reporting attribution — REPORTED BY, never an executor */
  reportedByUserId: string; // NOT NULL
  reportedAt: string; // NOT NULL; a row fact + ordering term, NOT a population filter

  /* Closure — `finding_closure_complete` guarantees all three are NULL unless
     status = 'CLOSED' */
  closedAt: string | null;
  closedByUserId: string | null; // CLOSED BY, never an executor
  closureNotes: string | null;

  /* Record timestamps */
  createdAt: string; // NOT NULL
  updatedAt: string; // NOT NULL; moves on every transition and source rebind

  /* Current ACTIVE assignment — 0..1 by partial unique index. ALL SEVEN are
     NULL when the finding is unassigned. No vendorWorkforceId exists:
     VENDOR_WORKFORCE = vendorId + workforceProfileId together. */
  assignmentId: string | null;
  assigneeType: FindingAssigneeType | null;
  workforceProfileId: string | null; // ASSIGNED TO target id
  teamId: string | null; // ASSIGNED TO target id
  vendorId: string | null; // ASSIGNED TO target id
  assignedByUserId: string | null; // ASSIGNED BY, never an executor
  assignedAt: string | null;
};

/**
 * Filters. `engine` is REQUIRED (R07 PART 02C / R08 PART 01B parity — an
 * explicit engine keeps pagination honest and selects the single authoritative
 * parent table).
 *
 * dateFrom/dateTo apply to the PARENT EXECUTION's created_at using R07/R04
 * half-open [start, end) semantics, so this child's population is exactly
 * "findings belonging to executions R07 would return for that range" — the same
 * meaning dateFrom/dateTo carry in every other R08 child. There is deliberately
 * NO finding-reportedAt population filter: `reportedAt` remains a row fact and an
 * ordering term only, so the two R08 children cannot diverge in what a date range
 * means.
 */
export type OperationalDetailFindingFilters = {
  engine: OperationalDetailEngine;
  buildingId?: string;
  executionId?: string; // narrowing only — never bypasses authorized building scope
  templateId?: string; // owning template (checklist_templates.id | form_templates.id)
  dateFrom?: string;
  dateTo?: string;
  status?: FindingStatus; // optional LITERAL filter over the findings vocabulary
};

export type OperationalDetailFindingPagination = {
  limit?: number;
  offset?: number;
};

export type OperationalDetailFindingQuery = OperationalDetailFindingFilters &
  OperationalDetailFindingPagination;

/** Envelope mirrors the closed R07 / R08 PART 01B read-model contract. */
export type PublicOperationalDetailFinding = {
  engine: OperationalDetailEngine;
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
  rows: PublicOperationalDetailFindingRow[];
};

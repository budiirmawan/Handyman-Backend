import type { FindingReworkStatus } from '../finding-rework/finding-rework.types';
import type { OperationalDetailEngine } from '../operational-detail-reporting/operational-detail-reporting.types';

/**
 * R08 PART 03B — Operational Detail Finding Rework child projection (types).
 *
 * READ MODEL ONLY. Backend-owned, read-only, internal (no HTTP endpoint).
 *
 * GRAIN
 *   ONE ROW per `finding_rework_cycles.id`.
 *   PARENT LINEAGE = engine → executionId → findingId → reworkCycleId, where
 *   engine is the R07 vocabulary CHECKLIST_EXECUTION | FORM_INSTANCE (reused,
 *   never redeclared), executionId is `findings.source_id`, and findingId is
 *   `finding_rework_cycles.finding_id` — all three traversed by PERSISTED keys.
 *   No execution, finding or cycle is ever inferred from timestamps, actors,
 *   evidence or free text.
 *
 *   The grain is per CYCLE, not per finding: `finding_current_rework_unique`
 *   constrains only REQUESTED cycles, so a finding legitimately carries many
 *   historical RESUBMITTED cycles. This child is therefore a historical lineage
 *   projection — the opposite of a latest-only summary.
 *
 * POPULATION (structural, no application filter)
 *   `f.source_type = <engine> AND f.source_id = parent.id` excludes SOURCELESS
 *   findings (NULL never equals a bound literal) and WORK_ORDER-sourced findings
 *   (WORK_ORDER is a valid stored `findings.source_type` but is NOT an R08 engine).
 *   `frc.finding_id = f.id` is an INNER join because the cycle IS the child grain:
 *   a finding with no cycle contributes no row.
 *
 * LIFECYCLE — exactly two stored statuses (migration 0096 `finding_rework_status`)
 *   REQUESTED → RESUBMITTED. RESUBMITTED is TERMINAL for the cycle: both mutating
 *   statements are guarded `WHERE id = $1 AND status = 'REQUESTED'`, so a finalized
 *   cycle can never be re-opened or rewritten. Historical cycles are append-preserved
 *   and remain permanently queryable — no delete path exists and no FK carries
 *   ON DELETE.
 *
 *   The DEFAULT read applies NO status predicate, so ALL cycles in ALL statuses are
 *   returned. `status` is an OPTIONAL LITERAL filter. NO derived lifecycle
 *   classification exists or may be added: no OPEN, CLOSED, ACTIVE, TERMINAL,
 *   SUCCESSFUL, ACCEPTED or VERIFIED partition — none is persisted.
 *
 *   RESUBMITTED MEANS ONLY that the finding was resubmitted from this cycle. It does
 *   NOT mean accepted, approved, verified or completed successfully. The outcome of a
 *   rework cycle is NOT persisted anywhere on the cycle, and this contract must never
 *   imply one.
 *
 * TRIGGER REVIEW SEMANTICS (R08 PART 03A §11)
 *   `triggerReviewId` is `finding_rework_cycles.review_id` — NOT NULL, UNIQUE
 *   (`finding_rework_review_unique`), never updated. It means ONLY: the review that
 *   CAUSED / anchored the creation of this cycle. Proven from
 *   `requestFindingRework`: from PENDING_REVIEW a NEW review with decision
 *   REWORK_REQUIRED is submitted; from REJECTED the EXISTING REJECTED review is
 *   reused. It is therefore NEVER the re-verification of the resubmission.
 *
 *   The later re-verification is a separate `reviews` row targeting the FINDING with
 *   NO persisted back-reference to the cycle, so it is NOT exposed and must NOT be
 *   inferred by ordering or timestamps. `reviews` is NOT joined in this PART: no
 *   decision, status, reviewer, notes or reviewedAt is exposed. Consequently the name
 *   is deliberately `triggerReviewId` and must never be renamed to
 *   verificationReviewId, reverificationReviewId, acceptanceReviewId or
 *   latestReviewId — each of those would assert a relation the schema does not store.
 *
 * REWORK NOTES SEMANTICS — MUTABLE AND STATUS-DEPENDENT (R08 PART 03A §8)
 *   `reworkNotes` maps `finding_rework_cycles.rework_notes`, a SINGLE mutable column
 *   with NO separate resubmission-notes counterpart:
 *     - while REQUESTED it may hold working / update notes (or NULL), written by
 *       `updateFindingReworkNotes`;
 *     - at resubmission `markResubmitted` OVERWRITES it with the resubmitter's notes.
 *   The pre-resubmission value is therefore NOT PRESERVED on the cycle row and is not
 *   recoverable from it. `reworkNotes` is exposed VERBATIM, and its meaning depends on
 *   `status`. It must NEVER be labelled exclusively as request notes, resubmission
 *   notes, resolution, result or correction result, must never be reconstructed, and
 *   must never be parsed to derive a status or outcome.
 *
 * REASON SEMANTICS
 *   `reason` maps `finding_rework_cycles.reason` — TEXT NOT NULL, set at INSERT and
 *   NEVER updated, so it is the STABLE rework instruction/reason persisted when the
 *   cycle was requested. It is user-entered operational text and is exposed verbatim:
 *   never classified into a severity, category, failure type or outcome, never parsed,
 *   never normalized.
 *
 * TWO BUILDING FACTS — deliberately distinct (R08 PART 02A/02B, preserved exactly)
 *   `finding_rework_cycles` stores NO building_id, so building authority comes through
 *   the Finding and the parent. `parentBuildingId` = the R04 authoritative building
 *   RESOLVED for the parent execution/instance. `findingBuildingId` =
 *   `findings.building_id` verbatim.
 *
 *   They MAY LEGITIMATELY DIFFER, because the historical write-time building authority
 *   was narrower than R04's: `resolveFindingSourceContext` returns no building at all
 *   for FORM_INSTANCE, and only the generated-task building for CHECKLIST_EXECUTION,
 *   whereas R04 resolves a seven-path COALESCE in which generated_tasks is LAST.
 *   `f.building_id = parentBuildingId` is therefore NOT an authoritative invariant and
 *   is NOT required — enforcing it would silently drop correctly created, correctly
 *   bound cycles.
 *
 *   SECURITY (both must hold, over the SAME authorized set):
 *     parentBuildingId  ∈ authorizedBuildingIds  (R04 resolution; NULL → fail-closed)
 *     findingBuildingId ∈ authorizedBuildingIds  (the finding's own isolation column)
 *   A row where only ONE of the two is authorized MUST NOT be returned. Both are
 *   non-nullable in this contract, since each is guaranteed by its own predicate. No
 *   buildingMismatch / sameBuilding / isBuildingConsistent interpretation exists or may
 *   be added — the two stored facts are enough.
 *
 * CLIENT CONSISTENCY (fail-closed, structural)
 *   `finding_rework_cycles` stores NO client_id, so client authority is INHERITED
 *   through the Finding — the same path two existing authorities already use
 *   (`loadEvidenceExecution` and the retention parent lookup both resolve
 *   `finding_rework_cycles r JOIN findings f ON f.id = r.finding_id` → f.client_id).
 *   `findings.source_id` has NO foreign key and nothing in the database ties
 *   `findings.client_id` to the parent execution's client, so the invariant is enforced
 *   STRUCTURALLY IN SQL as part of the join predicate
 *   (`f.client_id = parent.client_id`). A mismatched-client cycle is EXCLUDED by
 *   construction — never included-and-flagged, never an error, never post-filtered, and
 *   no caller-supplied clientId is ever consulted.
 *
 * ATTRIBUTION (R08 PART 03A §9)
 *   requestedByUserId   = REWORK REQUESTED BY — the user who requested the rework.
 *   resubmittedByUserId = RESUBMITTED BY — the user who resubmitted from this cycle.
 *   Those are the ONLY two persisted cycle actors. Neither is an executor: no field may
 *   be exposed or labelled Executed By / Performed By / Actual Executor / Completed By /
 *   Fixed By. The resubmitter was REQUIRED to be an active finding assignee at command
 *   time (`isUserActiveFindingAssignee`), but that was an AUTHORIZATION CONDITION, not a
 *   persisted executor fact. The actor of a notes edit is not persisted on the cycle at
 *   all (only `updated_at` moves), so it is UNAVAILABLE and is not exposed. No
 *   display-name join exists in this PART.
 *
 * NO HISTORICAL ASSIGNMENT (R08 PART 03A §12)
 *   Assignment is NOT snapshotted onto the cycle — none of assignee_type,
 *   workforce_profile_id, team_id, vendor_id or assignment_id is stored there.
 *   `finding_assignments` is NOT joined, because projecting today's ACTIVE assignment
 *   onto an old cycle would present a MUTABLE CURRENT value as though it were the
 *   assignee at rework time — a false historical claim that would silently change
 *   meaning on re-assignment. No historical rework assignee may be claimed. R08 PART
 *   02B remains the owner of the CURRENT active finding assignment.
 *
 * EVIDENCE BOUNDARY (R08 PART 03A §10)
 *   A DIRECT cycle→evidence relation DOES exist and is persisted:
 *   `evidence_submissions.execution_type = 'FINDING_REWORK'` with
 *   `execution_id = finding_rework_cycles.id` (migration 0277, written by the evidence
 *   module's rework handler and indexed by `evidence_submissions_finding_parent_idx`).
 *   It is deliberately OUT OF SCOPE here: cycle → evidence is 1:N and inlining rows
 *   would fan out the cycle grain. `evidence_submissions` is NOT joined and no
 *   evidenceCount, evidenceIds or evidence array is exposed. PART 01B execution
 *   evidence is NOT attached to a cycle — its engine vocabulary is
 *   CHECKLIST_EXECUTION | FORM_INSTANCE only, so FINDING_REWORK evidence is outside its
 *   population. The direct relation is reserved for a separate cycle-keyed child if
 *   ever required.
 *
 * EXCLUDED BY CONTRACT
 *   NO reviews join and NO verification / acceptance / rejection outcome of any kind
 *   (verificationDecision, verificationStatus, verificationReviewerUserId,
 *   verificationReviewedAt, acceptanceStatus, rejectionStatus, acceptedBy, rejectedBy) —
 *   the re-verification has no persisted cycle back-reference.
 *   NO operational_events join, no historyCount / historyAvailable. Note `reworkCycleId`
 *   appears inside `operational_events.metadata` JSONB in two unrelated modules; that is
 *   NOT a relational key (no FK, no index) and is never used as one.
 *   NO vendor_rework_cycles reference — vendor-work rework is a SEPARATE table
 *   (migration 0164) and a separate domain. No generic "rework" authority is created.
 *   NO CURRENT FINDING FACT DUPLICATION: no findingStatus, findingNumber, findingTitle,
 *   findingDescription, classificationId, severityId, and no classification/severity
 *   labels. Those are Finding-level facts — several of them MUTABLE (title, description,
 *   classification_id and severity_id are all rewritable via the finding update path) and
 *   none is snapshotted onto the cycle. `findingId` is the Finding lineage anchor, and
 *   R08 PART 02B / R02 own the finding facts. In particular NO `findingStatus`: a
 *   historical cycle row must not silently change semantic context merely because the
 *   finding's CURRENT status changes later.
 *   NO reworkCount and NO latestRework* field — those are R02 FINDING_REGISTER's
 *   finding-grain latest-only authority and are not duplicated here.
 *   NO priority, dueDate, assetId, functionalLocationId, display name, file reference,
 *   storage path, signed URL or secret.
 */

/**
 * `finding_rework_cycles.status` — the authoritative stored CHECK vocabulary
 * (`finding_rework_status`, migration 0096). Exactly two values; NO third status may be
 * added here.
 *
 * The finding-rework domain module exports the TypeScript type `FindingReworkStatus` but
 * NO runtime guard, so this is the smallest local runtime validator PART 03B needs. It
 * is not a competing vocabulary: the array's element type IS the domain type, so any
 * value outside the domain union is a compile error, and the focused test pins the exact
 * list against BOTH the domain type declaration and the migration 0096 CHECK. The domain
 * module is deliberately NOT modified to add a helper.
 */
export const FINDING_REWORK_CHILD_STATUSES: readonly FindingReworkStatus[] = [
  'REQUESTED',
  'RESUBMITTED',
] as const;

export function isFindingReworkChildStatus(value: unknown): value is FindingReworkStatus {
  return (
    typeof value === 'string' &&
    (FINDING_REWORK_CHILD_STATUSES as readonly string[]).includes(value)
  );
}

/** One historical rework-cycle lineage row. Every field is copied verbatim. */
export type PublicOperationalDetailFindingReworkRow = {
  /* Grain + parent lineage, all traversed by persisted keys */
  reworkCycleId: string; // finding_rework_cycles.id — the row grain and only locator
  engine: OperationalDetailEngine; // = findings.source_type, R07 vocabulary reused
  executionId: string; // = findings.source_id, authoritative parent execution/instance
  findingId: string; // = finding_rework_cycles.finding_id — the Finding lineage ANCHOR only

  /* Scope anchors (exposed verbatim; never trusted as input) */
  clientId: string; // inherited through the finding; a scope FACT, never a caller filter

  /* TWO distinct building facts — never collapsed, never compared, never interpreted.
     Both are guaranteed inside the caller's authorized set, so neither is nullable. */
  parentBuildingId: string; // R04 authoritative building RESOLVED for the parent
  findingBuildingId: string; // findings.building_id verbatim — the isolation column

  /* Cycle lifecycle — exactly two stored statuses, verbatim. RESUBMITTED is terminal and
     means ONLY "resubmitted from this cycle" — never accepted / approved / verified. */
  status: FindingReworkStatus;

  /* Free text, user-entered operational content — verbatim, never parsed or classified */
  reason: string; // STABLE: the rework instruction persisted at request time (NOT NULL)
  reworkNotes: string | null; // MUTABLE + STATUS-DEPENDENT: OVERWRITTEN at resubmission,
  //                             so the pre-resubmission value is NOT preserved here

  /* The only two persisted cycle actors. Neither is an executor. */
  requestedByUserId: string; // REWORK REQUESTED BY (NOT NULL, never updated)
  requestedAt: string; // NOT NULL, never updated — the cycle's lineage timestamp
  resubmittedByUserId: string | null; // RESUBMITTED BY — written exactly once, then terminal
  resubmittedAt: string | null; // written exactly once with the actor; CHECK-pinned to status

  /* The review that CAUSED this cycle — NOT a re-verification. `reviews` is never joined. */
  triggerReviewId: string; // = finding_rework_cycles.review_id (NOT NULL, UNIQUE)

  /* Cycle record timestamps */
  createdAt: string; // NOT NULL, never updated
  updatedAt: string; // NOT NULL but MUTABLE — moves on notes edits AND on resubmission,
  //                    so it is NOT a lineage timestamp and is never used for ordering
};

/**
 * Filters. `engine` is REQUIRED (R07 PART 02C / R08 PART 01B / 02B parity — an explicit
 * engine keeps pagination honest and selects the single authoritative parent table).
 *
 * dateFrom/dateTo apply to the PARENT EXECUTION's created_at using R07/R04 half-open
 * [start, end) semantics, so this child's population is exactly "rework cycles belonging
 * to executions R07 would return for that range" — the SAME meaning dateFrom/dateTo carry
 * in every other R08 child. They deliberately do NOT apply to `frc.requested_at` or
 * `frc.resubmitted_at`, which remain row facts. If a cycle-date window is ever needed it
 * must arrive as distinctly named filters (reworkRequestedFrom / reworkRequestedTo) in a
 * future PART; dateFrom/dateTo must never be overloaded.
 *
 * executionId, findingId and reworkCycleId are NARROWING only: each is ANDed after both
 * building predicates are established, so none can bypass building authorization.
 */
export type OperationalDetailFindingReworkFilters = {
  engine: OperationalDetailEngine;
  buildingId?: string;
  executionId?: string;
  findingId?: string;
  reworkCycleId?: string;
  templateId?: string; // owning template (checklist_templates.id | form_templates.id)
  dateFrom?: string;
  dateTo?: string;
  status?: FindingReworkStatus; // optional LITERAL filter over the two stored statuses
};

export type OperationalDetailFindingReworkPagination = {
  limit?: number;
  offset?: number;
};

export type OperationalDetailFindingReworkQuery = OperationalDetailFindingReworkFilters &
  OperationalDetailFindingReworkPagination;

/** Envelope mirrors the closed R07 / R08 PART 01B / 02B read-model contract. */
export type PublicOperationalDetailFindingRework = {
  engine: OperationalDetailEngine;
  buildingId: string | null;
  buildingScope: string[];
  dateFrom: string | null;
  dateTo: string | null;
  asOf: string;
  rows: PublicOperationalDetailFindingReworkRow[];
};

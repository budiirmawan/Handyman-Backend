import { getPool } from '../../database';
import type { OperationalDetailEngine } from '../operational-detail-reporting/operational-detail-reporting.types';
import type {
  OperationalDetailReviewHistoryFilters,
  OperationalDetailReviewHistoryPagination,
  PublicOperationalDetailReviewHistoryRow,
} from './operational-detail-review-history.types';

/**
 * R08 PART 04B — Operational Detail Review History child projection (repository).
 *
 * ONE bounded set-based query, parent-driven exactly like the closed R04/R07 read models and
 * R08 PART 01B / 02B / 03B. ONE row per `reviews.id` — the REVIEW is the grain, not the
 * execution. No per-execution loop, no N+1, and no unbounded execution-id materialization: the
 * authorized parent population is expressed IN SQL, so no list of execution ids ever reaches
 * application memory.
 *
 * THIS IS A HISTORY CHILD, NOT A LATEST SELECTOR
 *   R04 (`checklist-execution-summary`) and R07 (`checklist-execution-detail`,
 *   `form-execution-detail`) already own the LATEST COMPLETED execution review, each through
 *   `LEFT JOIN LATERAL (... WHERE status='COMPLETED' ORDER BY reviewed_at DESC, created_at
 *   DESC, id DESC LIMIT 1)`. That selector is NOT reproduced, mirrored, reconciled or extended
 *   here, and R04's `verificationReviewStatus` / R07's `verificationStatus` naming divergence
 *   is deliberately left untouched. This child owns what `LIMIT 1` destroys: EVERY review row,
 *   including earlier COMPLETED reviews and PENDING reviews, plus `notes`, `createdAt`,
 *   `updatedAt` and `clientId`, none of which R04/R07 project.
 *   Consequently there is no GROUP BY, no DISTINCT, no DISTINCT ON, no ROW_NUMBER, no LATERAL,
 *   no `LIMIT 1` per execution and no application-side collapse. Multiple reviews for one
 *   execution are expected and remain separate rows: nothing in the schema bounds them, since
 *   the partial unique indexes `finding_pending_review_unique`,
 *   `utility_abnormal_pending_review_unique` and `corrective_action_pending_review_unique`
 *   cover other target types and NEITHER `CHECKLIST_EXECUTION` NOR `FORM_INSTANCE`.
 *
 * LINEAGE IS TRAVERSED BY PERSISTED KEYS ONLY
 *   parent execution → reviews (`r.target_type` + `r.target_id`). No review is ever associated
 *   with an execution by timestamp, actor, notes text or event metadata.
 *
 * POPULATION IS STRUCTURAL
 *   `r.target_type = $1` is bound to an R07 engine literal, so the eight other values of
 *   migration 0286's `review_target` union (FINDING, WORK_ORDER, VENDOR_WORK,
 *   UTILITY_ABNORMAL_CONSUMPTION, PERMIT_APPLICATION, DOCUMENT, DOCUMENT_VERSION,
 *   CORRECTIVE_ACTION) are unreachable by construction — no application filter performs that
 *   exclusion and no generic all-domain review dataset is created. `reviews.target_id` carries
 *   NO foreign key, so a dangling target_id is possible in principle; starting FROM the parent
 *   and joining inward makes that harmless, because an orphan review never matches a real
 *   parent. The join is INNER, which is correct here because the review IS the grain: an
 *   execution with no review contributes no row. This differs deliberately from R04/R07's LEFT
 *   LATERAL, which must preserve the parent row.
 *
 * CLIENT CONSISTENCY IS STRUCTURAL (fail-closed)
 *   Unlike `finding_rework_cycles`, `reviews` DOES store `client_id` (UUID NOT NULL REFERENCES
 *   clients(id)), and both execution-target writers populate it from the parent:
 *   `review.service.createReview` copies `target.client_id` read from form_instances /
 *   checklist_executions, and `supervisor-inspection.createSharedReview` is passed
 *   `clientId: target.clientId`. Nothing in the database enforces that (target_id has no FK),
 *   so the invariant is enforced IN SQL as part of the join predicate:
 *     r.target_type = <engine>
 *     AND r.target_id = parent.id
 *     AND r.client_id = parent.client_id   ← mismatched rows are never fetched
 *   A mismatched-client review is EXCLUDED by construction — not included and flagged, not an
 *   error, not post-filtered after loading, and no caller-supplied clientId is consulted.
 *   Neither side can fan out the grain: `parent.id` is a primary key and `r.id` is the grain.
 *
 * EXACTLY ONE BUILDING PREDICATE (a deliberate simplification, not an omission)
 *   `reviews` stores NO building_id and no migration ever added one, so there is no second
 *   stored building fact. The PART 02B / 03B dual-building rule therefore does NOT apply here,
 *   and the R04-resolved parent building is the ONLY building authority:
 *     <R04 resolved parent building> = ANY($2::uuid[])
 *   Fail-closed: neither parent table stores a building_id, so resolution runs through the
 *   authoritative binding paths, and `NULL = ANY(...)` is not TRUE — an execution whose
 *   building cannot be resolved is EXCLUDED, never guessed.
 *   Inventing a review building, a second building predicate, a building-mismatch flag or a
 *   same-building interpretation would be a NEW building policy and is forbidden. Note in
 *   particular that `review.service.loadReviewTarget` performs a FORM_INSTANCE building check
 *   via `resolveBoundFormInstanceBuilding`: that is a WRITE-TIME authorization path over a
 *   narrower policy and is NOT adopted as the Reporting read authority (the same ruling PART
 *   03A made for `resolveFindingSourceContext`).
 *
 * BUILDING AUTHORITY PROVENANCE
 *   The R04/R07 resolution is reused; NO new building policy is invented. No bounded
 *   parent-resolution authority is exported anywhere: R04's summary repository is
 *   execution-grain but UNBOUNDED (no LIMIT), R07's detail repositories are bounded but
 *   item/field-grain and forbidden as a population source, and `loadReviewTarget` is per-id.
 *   R08 PART 01B §9 authorises the fallback and PART 02A §11 / 03A §14 / 04A §10 reaffirm it:
 *   the fragments below are copied VERBATIM from checklist-execution-summary.repository.ts
 *   (the R04 authority), so ONE policy is expressed identically rather than a second policy
 *   invented. PART 01B, 02B and 03B each hold module-private copies; they are NOT imported,
 *   because exporting them would require MODIFYING those closed PARTs, which this PART forbids.
 *   A fourth physical copy is therefore unavoidable, and the focused test pins the provenance
 *   chain PART 04B === PART 03B === R04 concisely. Consolidating into one shared copy is a
 *   separate refactor PART, not this one.
 *
 * OUT OF SCOPE — NO JOIN, NO FIELD
 *   users / user_profiles / employees / workforce_profiles / teams / clients / buildings (no
 *   display names — `reviewerUserId` is an id only), findings / finding_assignments /
 *   finding_rework_cycles (a FINDING-domain relation: `finding_rework_cycles.review_id` points
 *   at FINDING-target reviews, which PART 03B already exposes as `triggerReviewId` — there is
 *   NO relation from an execution review to a finding or a rework cycle, and none is inferred),
 *   vendor_rework_cycles, evidence_submissions (its `execution_type` vocabulary has no REVIEW
 *   value, so evidence can never point at a review row — it attaches to the execution, which is
 *   PART 01B's concern), operational_events (any reviewId there lives in JSONB metadata and is
 *   never a join key), and supervisor_inspections (a separate domain row that holds a
 *   `review_id` back-reference plus its own building/area/decision/notes — a consumer of
 *   execution reviews, never part of them).
 *
 * NO EXECUTION FACT is duplicated: no execution status, completedBy, assignee, response,
 * item/field/section/occurrence value or evidence count. `r.target_id` is projected purely as
 * the parent lineage anchor, and the parent's own current status never gates review visibility
 * (`loadReviewTarget` requires a COMPLETED target to OPEN a review, but that is a write-time
 * precondition, not a read-time filter).
 *
 * Explicit columns only, never `r.*`. Read-only: no INSERT, UPDATE, DELETE or DDL. No new
 * index is created — the existing `reviews_target_idx (target_type, target_id, created_at)`
 * covers both the join predicate and the ordering.
 */

/**
 * R04 checklist-execution building-resolution authority — copied VERBATIM from
 * checklist-execution-summary.repository.ts (CE_BUILDING_SQL), byte-identical to the
 * R08 PART 01B / 02B / 03B copies of the same authority. Requires the parent alias `ce`.
 * Deterministic seven-path order:
 *   engineering_checklist_binding -> inspection_binding ->
 *   toilet_inspection_binding -> public_area_inspection_binding ->
 *   patrol_checklist_binding -> vendor_checklist_binding -> generated_task
 * NULL when no path resolves, so the single `= ANY($2::uuid[])` predicate fails closed.
 */
const CE_BUILDING_SQL = `
  COALESCE(
    (SELECT b FROM (
       SELECT ecb.building_id AS b, ecb.asset_id AS a, ecb.functional_location_id AS f
         FROM engineering_checklist_bindings ecb WHERE ecb.id = ce.engineering_checklist_binding_id
       UNION ALL
       SELECT ib.building_id, ib.asset_id, ib.functional_location_id
         FROM inspection_bindings ib WHERE ib.id = ce.inspection_binding_id
       UNION ALL
       SELECT tib.building_id, NULL, tib.functional_location_id
         FROM toilet_inspection_bindings tib WHERE tib.id = ce.toilet_inspection_binding_id
       UNION ALL
       SELECT pa.building_id, NULL, pa.functional_location_id
         FROM public_area_inspection_bindings pa WHERE pa.id = ce.public_area_inspection_binding_id
       UNION ALL
       SELECT pb.building_id, NULL, NULL
         FROM patrol_checklist_bindings pb WHERE pb.id = ce.patrol_checklist_binding_id
       UNION ALL
       SELECT vcb.building_id, NULL, NULL
         FROM vendor_checklist_bindings vcb WHERE vcb.id = (
           SELECT v2.id FROM vendor_checklist_bindings v2
            WHERE v2.checklist_execution_id = ce.id LIMIT 1
         )
       UNION ALL
       SELECT gt.building_id, NULL, NULL
         FROM generated_tasks gt WHERE gt.id = ce.generated_task_id AND gt.building_id IS NOT NULL
     ) _paths LIMIT 1),
    NULL
  )
`;

/**
 * R04 form-instance building-resolution authority — copied VERBATIM from the `fi_base` CTE of
 * checklist-execution-summary.repository.ts, identical to the R08 PART 01B / 02B / 03B copies.
 * Requires the parent alias `fi`. meter_reading_binding -> log_sheet_binding ->
 * generated_task, else NULL.
 */
const FI_BUILDING_SQL = `
  COALESCE(
    (SELECT mrb.building_id FROM meter_reading_bindings mrb
      WHERE mrb.id = fi.meter_reading_binding_id),
    (SELECT lsb.building_id FROM log_sheet_bindings lsb
      WHERE lsb.id = fi.log_sheet_binding_id),
    (SELECT gt.building_id FROM generated_tasks gt
      WHERE gt.id = fi.generated_task_id AND gt.building_id IS NOT NULL),
    NULL
  )
`;

type ReviewHistoryRow = {
  review_id: string;
  engine: string;
  execution_id: string;
  client_id: string;
  parent_building_id: string;
  status: string;
  decision: string | null;
  reviewer_user_id: string;
  notes: string | null;
  created_at: Date;
  reviewed_at: Date | null;
  updated_at: Date;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Verbatim row mapping. Every value is copied as stored; NULLs are preserved and never
 * defaulted, coerced, trimmed or reinterpreted. No derived lifecycle, visibility, approval or
 * count field is produced, and no decision is normalized.
 */
function mapRow(row: ReviewHistoryRow): PublicOperationalDetailReviewHistoryRow {
  return {
    reviewId: row.review_id,
    // engine is the R07 vocabulary value read back from reviews.target_type verbatim
    engine: row.engine as OperationalDetailEngine,
    executionId: row.execution_id,
    clientId: row.client_id,

    // The ONLY building fact. reviews stores no building_id, so there is no second building to
    // expose and nothing to compare. Guaranteed non-NULL by its own `= ANY($2::uuid[])`
    // predicate, so a returned row can never carry a NULL building.
    parentBuildingId: row.parent_building_id,

    // Exactly two stored statuses. PENDING rows are first-class history here, not placeholders.
    status: row.status as PublicOperationalDetailReviewHistoryRow['status'],

    // NULL is meaningful and preserved: it is the stored state of a review with no decision.
    // Copied through the reused reviews authority, never mapped to PASS/FAIL/SUCCESS/VERIFIED.
    decision: row.decision as PublicOperationalDetailReviewHistoryRow['decision'],

    // The user recorded when the review was OPENED — never rewritten by any writer. NOT the
    // decision actor, which is not persisted; never relabeled Decided/Approved/Verified By and
    // never an executor label.
    reviewerUserId: row.reviewer_user_id,

    // Verbatim user-entered text. MUTABLE: overwritten at completion by decideReview
    // (`notes = $2`) and updateSharedReview (`notes = COALESCE($2, notes)`), so the historical
    // pre-overwrite value is UNAVAILABLE and is never reconstructed or relabeled.
    notes: row.notes,

    // createdAt is the only immutable timestamp (DEFAULT NOW(), never updated by any writer).
    createdAt: toIso(row.created_at) as string,
    // NULL until completion; written at completion, so never an ordering term.
    reviewedAt: toIso(row.reviewed_at),
    // Moves on every completion write — a record fact, never an ordering term.
    updatedAt: toIso(row.updated_at) as string,
  };
}

/**
 * ONE bounded query over the full execution review history of the authorized parent population.
 *
 * Pagination is at REVIEW-ROW grain and is independent of R04/R07 pages, R02 FINDING_REGISTER
 * and the R08 PART 01B / 02B / 03B pages.
 *
 * Deterministic ordering: `r.target_id ASC, r.created_at DESC, r.id ASC`.
 *   - target_id (executionId) ASC first — the invariant R08 family convention, so pages
 *     correlate across children (PART 01B `e.execution_id ASC`, PART 02B `f.source_id ASC`,
 *     PART 03B `f.source_id ASC`).
 *   - `created_at DESC, id` then mirrors the review authority's OWN history convention verbatim
 *     (`review.service.listReviewsByTarget`: `ORDER BY created_at DESC, id`), exactly as PART
 *     02B mirrored the finding authority's DESC direction and PART 03B mirrored the rework
 *     authority's ASC direction. Each child follows its own domain.
 *   - `r.id` is the primary key, so the order is TOTAL and stable across pages even when
 *     several reviews share one created_at instant — realistic here, since nothing bounds
 *     reviews per execution.
 * Deliberately NOT ordered by `reviewed_at` (NULL for every PENDING row, so any NULLS
 * FIRST/LAST choice would arbitrarily cluster or scatter pending reviews, and it is rewritten
 * at completion) and NOT by `updated_at` (moves on every completion write, which would
 * reshuffle pages). `created_at` is NOT NULL, written once and never updated.
 */
export async function getOperationalDetailReviewHistoryRows(
  buildingIds: string[],
  filters: OperationalDetailReviewHistoryFilters,
  start: Date | null,
  end: Date | null,
  pagination: OperationalDetailReviewHistoryPagination,
): Promise<PublicOperationalDetailReviewHistoryRow[]> {
  const isChecklist = filters.engine === 'CHECKLIST_EXECUTION';
  const parentAlias = isChecklist ? 'ce' : 'fi';
  const parentTable = isChecklist ? 'checklist_executions ce' : 'form_instances fi';
  const buildingSql = isChecklist ? CE_BUILDING_SQL : FI_BUILDING_SQL;

  const values: unknown[] = [filters.engine, buildingIds];
  const conditions: string[] = [];

  // The version → parent-template chain is joined only when templateId is filtered, matching
  // the R07/R04/PART 01B/02B/03B `templateId` = owning parent template semantic.
  const templateJoins =
    !isChecklist && filters.templateId
      ? `
       JOIN form_template_versions ftv ON ftv.id = ${parentAlias}.form_template_version_id
       JOIN form_templates ft ON ft.id = ftv.form_template_id`
      : '';

  // Parent-driven FROM. The client-consistency comparison is part of the JOIN predicate, so a
  // mismatched-client review is never fetched at all. The review join is INNER because the
  // review is the grain.
  const fromClause = `
     FROM ${parentTable}${templateJoins}
     JOIN reviews r
       ON r.target_type = $1
      AND r.target_id = ${parentAlias}.id
      AND r.client_id = ${parentAlias}.client_id`;

  // THE ONLY BUILDING PREDICATE — R04/R07 parent building authority, fail-closed: an
  // unresolvable building yields NULL, and NULL = ANY(...) is not TRUE, so the parent execution
  // is excluded and its reviews with it. There is no second predicate, because reviews has no
  // building anchor of its own.
  conditions.push(`${buildingSql} = ANY($2::uuid[])`);

  // Narrowing filters. Each is ANDed AFTER the building predicate is established, so none of
  // them can widen or bypass the authorized building scope.
  if (filters.executionId) {
    values.push(filters.executionId);
    conditions.push(`${parentAlias}.id = $${values.length}::uuid`);
  }
  if (filters.reviewId) {
    values.push(filters.reviewId);
    conditions.push(`r.id = $${values.length}::uuid`);
  }
  if (filters.templateId) {
    values.push(filters.templateId);
    conditions.push(
      isChecklist
        ? `ce.checklist_template_id = $${values.length}::uuid`
        : `ft.id = $${values.length}::uuid`,
    );
  }
  // Half-open [start, end) window over the PARENT execution's created_at — the R07/R04/PART
  // 01B/02B/03B population semantic, identical in meaning across every R08 child. There is
  // deliberately NO r.created_at, r.reviewed_at or r.updated_at population filter: all three
  // stay row facts, and a future review-date window must use distinctly named filters rather
  // than overloading dateFrom/dateTo.
  if (start) {
    values.push(start);
    conditions.push(`${parentAlias}.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`${parentAlias}.created_at < $${values.length}`);
  }

  // DEFAULT read: NO status predicate and NO decision predicate, so ALL persisted review rows
  // are returned — every status, every decision, NULL decisions included. No latest-only,
  // completed-only or approved-only view exists, and the parent execution's current status
  // never gates visibility. Both filters are OPTIONAL LITERALS over existing stored CHECK
  // vocabularies, bound as parameters and never inlined.
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`r.status = $${values.length}`);
  }
  if (filters.decision) {
    values.push(filters.decision);
    conditions.push(`r.decision = $${values.length}`);
  }

  let limitClause = '';
  if (pagination.limit !== undefined) {
    values.push(pagination.limit);
    limitClause = `LIMIT $${values.length}`;
  }
  let offsetClause = '';
  if (pagination.offset !== undefined) {
    values.push(pagination.offset);
    offsetClause = `OFFSET $${values.length}`;
  }

  const result = await getPool().query<ReviewHistoryRow>(
    `SELECT
       r.id                 AS review_id,
       r.target_type        AS engine,
       r.target_id          AS execution_id,
       r.client_id          AS client_id,
       ${buildingSql}       AS parent_building_id,
       r.status             AS status,
       r.decision           AS decision,
       r.reviewer_user_id   AS reviewer_user_id,
       r.notes              AS notes,
       r.created_at         AS created_at,
       r.reviewed_at        AS reviewed_at,
       r.updated_at         AS updated_at
     ${fromClause}
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY r.target_id ASC, r.created_at DESC, r.id ASC
     ${limitClause}
     ${offsetClause}`,
    values,
  );

  return result.rows.map(mapRow);
}

export const operationalDetailReviewHistoryRepository = {
  getOperationalDetailReviewHistoryRows,
};

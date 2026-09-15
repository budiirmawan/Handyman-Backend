import { getPool } from '../../database';
import type { OperationalDetailEngine } from '../operational-detail-reporting/operational-detail-reporting.types';
import type {
  OperationalDetailFindingReworkFilters,
  OperationalDetailFindingReworkPagination,
  PublicOperationalDetailFindingReworkRow,
} from './operational-detail-finding-rework.types';

/**
 * R08 PART 03B — Operational Detail Finding Rework child projection (repository).
 *
 * ONE bounded set-based query, parent-driven exactly like the closed R04/R07 read models
 * and R08 PART 01B / 02B. ONE row per `finding_rework_cycles.id` — the CYCLE is the grain,
 * not the finding. No per-finding loop, no N+1, and no unbounded execution-id
 * materialization: the authorized parent population is expressed IN SQL, so no list of
 * execution ids ever reaches application memory.
 *
 * LINEAGE IS TRAVERSED BY PERSISTED KEYS ONLY
 *   parent execution → findings (f.source_type + f.source_id) → finding_rework_cycles
 *   (frc.finding_id → f.id, NOT NULL FK). No execution, finding or cycle is ever inferred
 *   from timestamps, actors, evidence or free text.
 *
 * POPULATION IS STRUCTURAL
 *   `f.source_type = $1 AND f.source_id = parent.id` excludes SOURCELESS findings (NULL
 *   never equals a bound engine literal) and WORK_ORDER findings (not an R08 engine) by
 *   construction — no application filter performs either exclusion. The join on
 *   `finding_rework_cycles` is INNER, which is correct here because the cycle IS the child
 *   grain: a finding with no cycle must contribute no row. This differs deliberately from
 *   PART 02B's assignment join, which is LEFT because the assignment is an optional
 *   ATTRIBUTE of that grain.
 *
 * CLIENT CONSISTENCY IS STRUCTURAL (fail-closed)
 *   `finding_rework_cycles` stores NO client_id, so client authority is inherited through
 *   the finding — the same path `loadEvidenceExecution` and the evidence-retention parent
 *   lookup already use (`finding_rework_cycles r JOIN findings f ON f.id = r.finding_id`).
 *   `findings.source_id` carries NO FOREIGN KEY and nothing in the database ties
 *   `findings.client_id` to the parent execution's client, so the invariant is enforced IN
 *   SQL as part of the join predicate:
 *     f.source_type = <engine>
 *     AND f.source_id = parent.id
 *     AND f.client_id = parent.client_id   ← mismatched rows are never fetched
 *   A mismatched-client cycle is EXCLUDED by construction — not included and flagged, not an
 *   error, not post-filtered after loading, and no caller-supplied clientId is consulted.
 *   Neither join can fan out the grain: `parent.id` and `f.id` are primary keys, and
 *   `frc.id` is the grain itself.
 *
 * TWO INDEPENDENT BUILDING PREDICATES, ONE AUTHORIZED SET (PART 02B rule preserved exactly)
 *   `finding_rework_cycles` stores NO building_id, so both facts come from the finding and
 *   the parent. BOTH must hold over the SAME `$2` building parameter:
 *     1. `<R04 resolved parent building> = ANY($2::uuid[])` — the parent execution/instance
 *        must resolve INTO the authorized scope. Fail-closed: neither parent table stores a
 *        building_id, so resolution runs through the authoritative binding paths, and
 *        `NULL = ANY(...)` is not TRUE — an execution whose building cannot be resolved is
 *        EXCLUDED, never guessed.
 *     2. `f.building_id = ANY($2::uuid[])` — the finding's OWN stored isolation column must
 *        independently be inside the same authorized scope (the R02 / BE-23H convention).
 *   A row where only ONE of the two buildings is authorized is therefore never returned.
 *
 *   DELIBERATELY NOT `f.building_id = <resolved parent building>`. That equality is NOT an
 *   authoritative invariant: the historical write-time building authority was narrower than
 *   R04's (for FORM_INSTANCE the finding-source resolver returns no building at all, so the
 *   bind-time comparison never runs; for CHECKLIST_EXECUTION it resolves only via
 *   generated_task → generated_tasks, whereas R04 resolves a seven-path COALESCE in which
 *   generated_tasks is LAST). Requiring it would silently drop correctly created, correctly
 *   bound cycles. Both buildings are instead PROJECTED as distinct stored facts
 *   (`parentBuildingId`, `findingBuildingId`) with no derived mismatch / consistency /
 *   same-building interpretation.
 *
 *   There is NO third building predicate: the cycle has no building anchor of its own, and
 *   inventing one would be unauthoritative.
 *
 * BUILDING AUTHORITY PROVENANCE
 *   The R04/R07 resolution is reused; NO new building policy is invented, and
 *   `resolveFindingSourceContext` is NOT used as the Reporting authority (it resolves one
 *   source at a time — a per-row N+1 — over a narrower, non-R04 policy). No bounded
 *   parent-resolution authority is exported anywhere: R04's summary repository is
 *   execution-grain but UNBOUNDED (no LIMIT), R07's detail repositories are bounded but
 *   item/field-grain and forbidden as a population source, and `loadEvidenceExecution` is
 *   per-id and client-scoped. R08 PART 01B §9 authorises the fallback and PART 02A §11 /
 *   PART 03A §14 reaffirm it: the fragments below are copied VERBATIM from
 *   checklist-execution-summary.repository.ts (the R04 authority), so ONE policy is
 *   expressed identically rather than a second policy invented.
 *
 *   PART 01B and PART 02B each hold module-private copies of the same two fragments. They
 *   are NOT imported, because exporting them would require MODIFYING those closed PARTs,
 *   which this PART forbids; a third physical copy is therefore unavoidable here. The copies
 *   are kept identical by construction and the focused test pins the full provenance chain
 *   PART 03B === PART 02B === PART 01B === R04 (CE byte-for-byte; FI against R04's inline
 *   `fi_base` fragment, whitespace-normalized because R04 stores it inline). Any future
 *   drift fails the test rather than diverging silently. Consolidating into one shared copy
 *   is a separate refactor PART, not this one.
 *
 * OUT OF SCOPE — NO JOIN, NO FIELD
 *   reviews (the only cycle review fact is `review_id`, exposed as `triggerReviewId`; the
 *   re-verification has no persisted cycle back-reference and must not be inferred),
 *   evidence_submissions (a DIRECT 1:N relation exists via execution_type='FINDING_REWORK' +
 *   execution_id=frc.id, but inlining rows would fan out the cycle grain — reserved for a
 *   separate cycle-keyed child), finding_assignments (assignment is NOT snapshotted on the
 *   cycle, so today's ACTIVE assignment must not masquerade as the assignee at rework time),
 *   operational_events, finding_classifications, finding_severities, vendor_rework_cycles,
 *   and every display-name table.
 *
 * NO CURRENT FINDING FACT is duplicated: no findingStatus, findingNumber, title,
 * description, classificationId or severityId. Several are mutable and none is snapshotted
 * onto the cycle, so a historical row must not change semantic context when the finding
 * changes later. `f.id` is projected purely as the lineage anchor.
 *
 * Explicit columns only, never `f.*` / `frc.*`. Read-only: no INSERT, UPDATE, DELETE or DDL.
 */

/**
 * R04 checklist-execution building-resolution authority — copied VERBATIM from
 * checklist-execution-summary.repository.ts (CE_BUILDING_SQL), byte-identical to the
 * R08 PART 01B and PART 02B copies of the same authority. Requires the parent alias `ce`.
 * Deterministic order:
 *   engineering_checklist_binding -> inspection_binding ->
 *   toilet_inspection_binding -> public_area_inspection_binding ->
 *   patrol_checklist_binding -> vendor_checklist_binding ->
 *   generated_task
 * NULL when no path resolves, so the `= ANY($2::uuid[])` predicate fails closed.
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
 * R04 form-instance building-resolution authority — copied VERBATIM from the `fi_base` CTE
 * of checklist-execution-summary.repository.ts, identical to the R08 PART 01B and PART 02B
 * copies of the same authority. Requires the parent alias `fi`.
 * meter_reading_binding -> log_sheet_binding -> generated_task, else NULL.
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

type FindingReworkRow = {
  rework_cycle_id: string;
  engine: string;
  execution_id: string;
  finding_id: string;
  client_id: string;
  parent_building_id: string;
  finding_building_id: string;
  status: string;
  reason: string;
  rework_notes: string | null;
  requested_by_user_id: string;
  requested_at: Date;
  resubmitted_by_user_id: string | null;
  resubmitted_at: Date | null;
  trigger_review_id: string;
  created_at: Date;
  updated_at: Date;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Verbatim row mapping. Every value is copied as stored; NULLs are preserved and never
 * defaulted, coerced or reinterpreted. No derived lifecycle, outcome, mismatch or
 * consistency field is produced. No actor is relabelled as an executor:
 * requestedByUserId is REWORK REQUESTED BY and resubmittedByUserId is RESUBMITTED BY.
 */
function mapRow(row: FindingReworkRow): PublicOperationalDetailFindingReworkRow {
  return {
    reworkCycleId: row.rework_cycle_id,
    // engine is the R07 vocabulary value read back from findings.source_type verbatim
    engine: row.engine as OperationalDetailEngine,
    executionId: row.execution_id,
    // findingId is the lineage ANCHOR only — no finding-level fact is duplicated here
    findingId: row.finding_id,
    clientId: row.client_id,

    // TWO distinct building facts, never collapsed and never compared. Both are guaranteed
    // non-NULL by their own `= ANY($2::uuid[])` predicate, so a returned row can never
    // carry a NULL building.
    parentBuildingId: row.parent_building_id,
    findingBuildingId: row.finding_building_id,

    // Exactly two stored statuses. RESUBMITTED is terminal and means ONLY "resubmitted from
    // this cycle" — never accepted, approved, verified or successfully completed.
    status: row.status as PublicOperationalDetailFindingReworkRow['status'],

    // reason is STABLE (NOT NULL, never updated). reworkNotes is MUTABLE and
    // STATUS-DEPENDENT: markResubmitted OVERWRITES it, so the pre-resubmission value is not
    // preserved on this row. Both are user-entered operational text, copied verbatim and
    // never parsed, classified or normalized into a status, severity or outcome.
    reason: row.reason,
    reworkNotes: row.rework_notes,

    requestedByUserId: row.requested_by_user_id,
    requestedAt: toIso(row.requested_at) as string,
    // Written exactly once: markResubmitted is guarded `WHERE status='REQUESTED'` and
    // RESUBMITTED is terminal, and finding_rework_resubmission_complete CHECK-pins the
    // actor/timestamp pair to the status.
    resubmittedByUserId: row.resubmitted_by_user_id,
    resubmittedAt: toIso(row.resubmitted_at),

    // The review that CAUSED this cycle — NOT its re-verification. `reviews` is never
    // joined, so no decision / status / reviewer / notes / reviewedAt is exposed.
    triggerReviewId: row.trigger_review_id,

    createdAt: toIso(row.created_at) as string,
    // updated_at moves on notes edits AND on resubmission, so it is exposed as a record fact
    // but is never used for ordering.
    updatedAt: toIso(row.updated_at) as string,
  };
}

/**
 * ONE bounded query over historical rework cycles for the authorized parent population.
 *
 * Pagination is at REWORK-CYCLE-ROW grain and is independent of R07 detail pages, R02
 * FINDING_REGISTER and R08 PART 02B pages.
 *
 * Deterministic historical ordering: executionId (source_id) ASC, findingId ASC, then the
 * finding-rework module's OWN list convention `ORDER BY requested_at, id` verbatim
 * (findingReworkRepository.listByFindingId) — ASC because this is a lineage/history child,
 * so cycles read in the order they happened. `frc.id` is the primary key, so the order is
 * total and stable across pages even when cycles share a requested_at instant.
 * Deliberately NOT ordered by `updated_at` (it moves on every notes edit and on
 * resubmission, which would make pages unstable) and NOT by `created_at` alone.
 */
export async function getOperationalDetailFindingReworkRows(
  buildingIds: string[],
  filters: OperationalDetailFindingReworkFilters,
  start: Date | null,
  end: Date | null,
  pagination: OperationalDetailFindingReworkPagination,
): Promise<PublicOperationalDetailFindingReworkRow[]> {
  const isChecklist = filters.engine === 'CHECKLIST_EXECUTION';
  const parentAlias = isChecklist ? 'ce' : 'fi';
  const parentTable = isChecklist ? 'checklist_executions ce' : 'form_instances fi';
  const buildingSql = isChecklist ? CE_BUILDING_SQL : FI_BUILDING_SQL;

  const values: unknown[] = [filters.engine, buildingIds];
  const conditions: string[] = [];

  // The version → parent-template chain is joined only when templateId is filtered, matching
  // the R07/R04/PART 01B/PART 02B `templateId` = owning parent template semantic.
  const templateJoins =
    !isChecklist && filters.templateId
      ? `
       JOIN form_template_versions ftv ON ftv.id = ${parentAlias}.form_template_version_id
       JOIN form_templates ft ON ft.id = ftv.form_template_id`
      : '';

  // Parent-driven FROM. The client-consistency comparison is part of the JOIN predicate, so a
  // mismatched-client cycle is never fetched at all. The cycle join is INNER because the
  // cycle is the grain.
  const fromClause = `
     FROM ${parentTable}${templateJoins}
     JOIN findings f
       ON f.source_type = $1
      AND f.source_id = ${parentAlias}.id
      AND f.client_id = ${parentAlias}.client_id
     JOIN finding_rework_cycles frc
       ON frc.finding_id = f.id`;

  // PREDICATE 1 — R04/R07 parent building authority, fail-closed: an unresolvable building
  // yields NULL, and NULL = ANY(...) is not TRUE, so the parent execution is excluded and its
  // findings and cycles with it.
  conditions.push(`${buildingSql} = ANY($2::uuid[])`);

  // PREDICATE 2 — the finding's OWN stored isolation column must independently be inside the
  // SAME authorized set ($2, one parameter, no second policy). NOT an equality against the
  // resolved parent building: see the header. A row where only one of the two buildings is
  // authorized is never returned. The cycle has no building anchor, so there is no third
  // predicate.
  conditions.push(`f.building_id = ANY($2::uuid[])`);

  // Narrowing filters. Each is ANDed AFTER both building predicates are established, so none
  // of them can widen or bypass the authorized building scope.
  if (filters.executionId) {
    values.push(filters.executionId);
    conditions.push(`${parentAlias}.id = $${values.length}::uuid`);
  }
  if (filters.findingId) {
    values.push(filters.findingId);
    conditions.push(`f.id = $${values.length}::uuid`);
  }
  if (filters.reworkCycleId) {
    values.push(filters.reworkCycleId);
    conditions.push(`frc.id = $${values.length}::uuid`);
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
  // 01B/PART 02B population semantic, identical in meaning across every R08 child. There is
  // deliberately NO frc.requested_at or frc.resubmitted_at population filter: both stay row
  // facts, and a future cycle-date window must use distinctly named filters rather than
  // overloading dateFrom/dateTo.
  if (start) {
    values.push(start);
    conditions.push(`${parentAlias}.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`${parentAlias}.created_at < $${values.length}`);
  }

  // DEFAULT read: NO status predicate, so ALL historical cycles in BOTH stored statuses are
  // returned — no latest-only, no current-cycle-only, no REQUESTED-only view. The filter is an
  // OPTIONAL LITERAL over migration 0096's two-value CHECK vocabulary, bound as a parameter.
  // No derived OPEN / CLOSED / ACTIVE / TERMINAL / SUCCESSFUL / ACCEPTED / VERIFIED mode
  // exists, and the finding's CURRENT status never gates cycle visibility.
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`frc.status = $${values.length}`);
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

  const result = await getPool().query<FindingReworkRow>(
    `SELECT
       frc.id                       AS rework_cycle_id,
       f.source_type                AS engine,
       f.source_id                  AS execution_id,
       f.id                         AS finding_id,
       f.client_id                  AS client_id,
       ${buildingSql}               AS parent_building_id,
       f.building_id                AS finding_building_id,
       frc.status                   AS status,
       frc.reason                   AS reason,
       frc.rework_notes             AS rework_notes,
       frc.requested_by_user_id     AS requested_by_user_id,
       frc.requested_at             AS requested_at,
       frc.resubmitted_by_user_id   AS resubmitted_by_user_id,
       frc.resubmitted_at           AS resubmitted_at,
       frc.review_id                AS trigger_review_id,
       frc.created_at               AS created_at,
       frc.updated_at               AS updated_at
     ${fromClause}
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY f.source_id ASC, f.id ASC, frc.requested_at ASC, frc.id ASC
     ${limitClause}
     ${offsetClause}`,
    values,
  );

  return result.rows.map(mapRow);
}

export const operationalDetailFindingReworkRepository = {
  getOperationalDetailFindingReworkRows,
};

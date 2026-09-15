import { getPool } from '../../database';
import type { OperationalDetailEngine } from '../operational-detail-reporting/operational-detail-reporting.types';
import type {
  OperationalDetailFindingFilters,
  OperationalDetailFindingPagination,
  PublicOperationalDetailFindingRow,
} from './operational-detail-finding.types';

/**
 * R08 PART 02B — Operational Detail Finding child projection (repository).
 *
 * ONE bounded set-based query, parent-driven exactly like the closed R04/R07 read
 * models and R08 PART 01B. ONE row per `findings.id`. No per-execution loop, no
 * N+1, and no unbounded parent-id materialization: the authorized parent
 * population is expressed IN SQL, so no list of execution ids ever reaches
 * application memory.
 *
 * POPULATION IS STRUCTURAL (R08 PART 02A §8, §10)
 *   `f.source_type = $1 AND f.source_id = parent.id` excludes SOURCELESS findings
 *   (source_type IS NULL never equals a bound engine literal) and WORK_ORDER
 *   findings (not an R08 engine) by construction. No application filter performs
 *   either exclusion.
 *
 * CLIENT CONSISTENCY IS STRUCTURAL (R08 PART 02A §4 — decision A, fail-closed)
 *   `findings.source_id` carries NO FOREIGN KEY and nothing in the database ties
 *   `findings.client_id` to the parent execution's client, so the invariant is
 *   enforced IN SQL as part of the join predicate:
 *     f.source_type = <engine>
 *     AND f.source_id = parent.id
 *     AND f.client_id = parent.client_id   ← mismatched rows are never fetched
 *   A mismatched-client finding is EXCLUDED by construction — not included and
 *   flagged, not an error, not post-filtered after loading, and no caller-supplied
 *   clientId is ever consulted. The join cannot fan out: `parent.id` is a PRIMARY
 *   KEY, so each finding matches at most one parent row.
 *
 * TWO INDEPENDENT BUILDING PREDICATES, ONE AUTHORIZED SET (R08 PART 02A §5, §6)
 *   BOTH must hold over the SAME `$2` building parameter:
 *     1. `<R04 resolved parent building> = ANY($2::uuid[])` — the parent
 *        execution/instance must resolve INTO the authorized scope. Fail-closed:
 *        neither parent table stores a building_id, so resolution runs through the
 *        authoritative binding paths, and `NULL = ANY(...)` is not TRUE — an
 *        execution whose building cannot be resolved is EXCLUDED, never guessed.
 *     2. `f.building_id = ANY($2::uuid[])` — the finding's OWN stored isolation
 *        column must independently be inside the same authorized scope. This is
 *        the established convention (`findings.building_id` is the isolation
 *        column in R02 FINDING_REGISTER and in BE-23H / BE-23I /
 *        vendor-service-register).
 *   A row where only ONE of the two buildings is authorized is therefore never
 *   returned, and `source_id` pointing at an authorized execution can never become
 *   a channel for reading another building's finding metadata.
 *
 *   DELIBERATELY NOT `f.building_id = <resolved parent building>`. That equality is
 *   NOT an authoritative invariant: the historical write-time building authority
 *   was narrower than R04's (for FORM_INSTANCE the finding-source resolver returns
 *   no building at all, so the bind-time building comparison never runs; for
 *   CHECKLIST_EXECUTION it resolves only via generated_task → generated_tasks,
 *   whereas R04 resolves a seven-path COALESCE in which generated_tasks is LAST).
 *   Requiring the equality would silently drop correctly created, correctly bound
 *   findings — an invisible correctness regression. Both buildings are instead
 *   PROJECTED as distinct stored facts (`parentBuildingId`, `findingBuildingId`)
 *   with no derived mismatch / consistency / same-building interpretation.
 *
 * BUILDING AUTHORITY PROVENANCE (R08 PART 02A §11, §15)
 *   The R04/R07 resolution is reused; NO new building policy is invented, and the
 *   finding-source resolver is NOT used as the Reporting authority. No bounded
 *   parent-resolution authority is exported anywhere in the repository — R04's
 *   summary repository is execution-grain but UNBOUNDED (no LIMIT), R07's detail
 *   repositories are bounded but item/field-grain and forbidden as a population
 *   source, and `resolveFindingSourceContext` is one-source-at-a-time (a per-row
 *   N+1) over a narrower, non-R04 policy. R08 PART 01B §9 therefore authorises the
 *   fallback, and PART 02A §11 reaffirms it: the fragments below are copied
 *   VERBATIM from checklist-execution-summary.repository.ts (the R04 authority), so
 *   ONE policy is expressed identically rather than a second policy invented.
 *
 *   PART 01B holds module-private copies of the same two fragments. They are NOT
 *   imported, because exporting them would require MODIFYING R08 PART 01B, which
 *   this PART forbids. The copies are kept identical by construction and the
 *   focused test asserts the full provenance chain: PART 02B CE === PART 01B CE ===
 *   R04 CE byte-for-byte, and PART 02B FI === PART 01B FI === R04's inline
 *   `fi_base` fragment (whitespace-normalized, since R04 stores it inline). Any
 *   future drift fails the test rather than diverging silently.
 *
 * ACTIVE ASSIGNMENT IS INLINE AND FAN-OUT-FREE (R08 PART 02A §11 — decision B)
 *   `finding_active_assignment_unique` is a PARTIAL UNIQUE index on (finding_id)
 *   WHERE status = 'ACTIVE', so the schema guarantees 0..1 ACTIVE assignment per
 *   finding. The LEFT JOIN can therefore match at most one row, the finding grain
 *   is preserved, and no GROUP BY / DISTINCT de-duplication is needed. LEFT (not
 *   INNER) so an unassigned finding still returns, with all seven assignment
 *   fields NULL. No display-name join is performed.
 *
 * NO rework, review, history, evidence, classification/severity label, work-order
 * enrichment, asset or functional-location join exists here — see the types
 * contract. Explicit columns only, never `f.*` / `fa.*`. Read-only: no INSERT,
 * UPDATE, DELETE or DDL.
 */

/**
 * R04 checklist-execution building-resolution authority — copied VERBATIM from
 * checklist-execution-summary.repository.ts (CE_BUILDING_SQL), byte-identical to
 * the R08 PART 01B copy of the same authority. Requires the parent alias `ce`.
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
 * R04 form-instance building-resolution authority — copied VERBATIM from the
 * `fi_base` CTE of checklist-execution-summary.repository.ts, identical to the
 * R08 PART 01B copy of the same authority. Requires the parent alias `fi`.
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

type FindingRow = {
  finding_id: string;
  engine: string;
  execution_id: string;
  client_id: string;
  parent_building_id: string;
  finding_building_id: string;
  finding_number: string;
  title: string;
  description: string | null;
  classification_id: string | null;
  severity_id: string | null;
  status: string;
  state_changed_at: Date;
  reported_by_user_id: string;
  reported_at: Date;
  closed_at: Date | null;
  closed_by_user_id: string | null;
  closure_notes: string | null;
  created_at: Date;
  updated_at: Date;
  assignment_id: string | null;
  assignee_type: string | null;
  workforce_profile_id: string | null;
  team_id: string | null;
  vendor_id: string | null;
  assigned_by_user_id: string | null;
  assigned_at: Date | null;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Verbatim row mapping. Every value is copied as stored; NULLs are preserved and
 * never defaulted, coerced, or reinterpreted. No derived lifecycle, mismatch,
 * consistency, integrity or availability field is produced. No actor is relabelled
 * as an executor: reportedByUserId is REPORTED BY, closedByUserId is CLOSED BY and
 * assignedByUserId is ASSIGNED BY.
 */
function mapRow(row: FindingRow): PublicOperationalDetailFindingRow {
  return {
    findingId: row.finding_id,
    // engine is the R07 vocabulary value read back from source_type verbatim
    engine: row.engine as OperationalDetailEngine,
    executionId: row.execution_id,
    clientId: row.client_id,

    // TWO distinct building facts, never collapsed and never compared. Both are
    // guaranteed non-NULL by their own `= ANY($2::uuid[])` predicate, so a
    // returned row can never carry a NULL building.
    parentBuildingId: row.parent_building_id,
    findingBuildingId: row.finding_building_id,

    findingNumber: row.finding_number,
    title: row.title,
    description: row.description,

    // Reference IDs ONLY — the live code/name/rank labels belong to R02 and are
    // deliberately not joined, so no historical label claim is implied.
    classificationId: row.classification_id,
    severityId: row.severity_id,

    // Verbatim stored lifecycle. All ten statuses are representable and visible by
    // default; CLOSED and CANCELLED are lineage, not something to hide.
    status: row.status as PublicOperationalDetailFindingRow['status'],
    stateChangedAt: toIso(row.state_changed_at) as string,

    reportedByUserId: row.reported_by_user_id,
    reportedAt: toIso(row.reported_at) as string,

    // `finding_closure_complete` guarantees all three are NULL unless CLOSED.
    closedAt: toIso(row.closed_at),
    closedByUserId: row.closed_by_user_id,
    closureNotes: row.closure_notes,

    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,

    // Current ACTIVE assignment: 0..1 by partial unique index. All seven are NULL
    // when unassigned. VENDOR_WORKFORCE = vendorId + workforceProfileId together;
    // there is no vendorWorkforceId column and none is invented.
    assignmentId: row.assignment_id,
    assigneeType: row.assignee_type as PublicOperationalDetailFindingRow['assigneeType'],
    workforceProfileId: row.workforce_profile_id,
    teamId: row.team_id,
    vendorId: row.vendor_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: toIso(row.assigned_at),
  };
}

/**
 * ONE bounded query over finding rows for the authorized parent population.
 *
 * Pagination is at FINDING-ROW grain and is independent of any R07 detail page.
 * Deterministic total ordering: executionId (source_id) ASC to cluster findings
 * under their parent execution, then the R02 FINDING_REGISTER convention verbatim
 * within each execution — reportedAt DESC, createdAt DESC, findingId ASC. `f.id` is
 * the primary key so the order is total and stable across pages.
 * Deliberately NOT ordered by updatedAt (mutated by every transition and source
 * rebind) and NOT by stateChangedAt alone (not unique).
 */
export async function getOperationalDetailFindingRows(
  buildingIds: string[],
  filters: OperationalDetailFindingFilters,
  start: Date | null,
  end: Date | null,
  pagination: OperationalDetailFindingPagination,
): Promise<PublicOperationalDetailFindingRow[]> {
  const isChecklist = filters.engine === 'CHECKLIST_EXECUTION';
  const parentAlias = isChecklist ? 'ce' : 'fi';
  const parentTable = isChecklist ? 'checklist_executions ce' : 'form_instances fi';
  const buildingSql = isChecklist ? CE_BUILDING_SQL : FI_BUILDING_SQL;

  const values: unknown[] = [filters.engine, buildingIds];
  const conditions: string[] = [];

  // The version → parent-template chain is joined only when templateId is
  // filtered, matching the R07/R04/PART 01B `templateId` = owning parent template
  // semantic.
  const templateJoins =
    !isChecklist && filters.templateId
      ? `
       JOIN form_template_versions ftv ON ftv.id = ${parentAlias}.form_template_version_id
       JOIN form_templates ft ON ft.id = ftv.form_template_id`
      : '';

  // Parent-driven FROM. The client-consistency comparison is part of the JOIN
  // predicate, so a mismatched-client finding is never fetched at all. The ACTIVE
  // assignment is LEFT-joined at schema-guaranteed 0..1, so it cannot fan out the
  // finding grain.
  const fromClause = `
     FROM ${parentTable}${templateJoins}
     JOIN findings f
       ON f.source_type = $1
      AND f.source_id = ${parentAlias}.id
      AND f.client_id = ${parentAlias}.client_id
     LEFT JOIN finding_assignments fa
       ON fa.finding_id = f.id
      AND fa.status = 'ACTIVE'`;

  // PREDICATE 1 — R04/R07 parent building authority, fail-closed: an unresolvable
  // building yields NULL, and NULL = ANY(...) is not TRUE, so the parent execution
  // is excluded and its findings with it.
  conditions.push(`${buildingSql} = ANY($2::uuid[])`);

  // PREDICATE 2 — the finding's OWN stored isolation column must independently be
  // inside the SAME authorized set ($2, one parameter, no second policy). NOT an
  // equality against the resolved parent building: see the header. A row where only
  // one of the two buildings is authorized is never returned.
  conditions.push(`f.building_id = ANY($2::uuid[])`);

  // Parent-population narrowing. executionId narrows only — it can never widen the
  // authorized building scope established above.
  if (filters.executionId) {
    values.push(filters.executionId);
    conditions.push(`${parentAlias}.id = $${values.length}::uuid`);
  }
  if (filters.templateId) {
    values.push(filters.templateId);
    conditions.push(
      isChecklist
        ? `ce.checklist_template_id = $${values.length}::uuid`
        : `ft.id = $${values.length}::uuid`,
    );
  }
  // Half-open [start, end) window over the PARENT execution's created_at — the
  // R07/R04/PART 01B population semantic, identical in meaning across every R08
  // child. There is deliberately NO competing finding-reported_at population
  // filter: reportedAt stays a row fact and an ordering term.
  if (start) {
    values.push(start);
    conditions.push(`${parentAlias}.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`${parentAlias}.created_at < $${values.length}`);
  }

  // DEFAULT read: NO status predicate, so all ten stored statuses — including
  // terminal CLOSED and CANCELLED — remain visible as lineage. The filter is an
  // OPTIONAL LITERAL over the findings module's own CHECK vocabulary, bound as a
  // parameter. No derived isOpen / isClosed / isTerminal mode exists.
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`f.status = $${values.length}`);
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

  const result = await getPool().query<FindingRow>(
    `SELECT
       f.id                        AS finding_id,
       f.source_type               AS engine,
       f.source_id                 AS execution_id,
       f.client_id                 AS client_id,
       ${buildingSql}              AS parent_building_id,
       f.building_id               AS finding_building_id,
       f.finding_number            AS finding_number,
       f.title                     AS title,
       f.description               AS description,
       f.classification_id         AS classification_id,
       f.severity_id               AS severity_id,
       f.status                    AS status,
       f.state_changed_at          AS state_changed_at,
       f.reported_by_user_id       AS reported_by_user_id,
       f.reported_at               AS reported_at,
       f.closed_at                 AS closed_at,
       f.closed_by_user_id         AS closed_by_user_id,
       f.closure_notes             AS closure_notes,
       f.created_at                AS created_at,
       f.updated_at                AS updated_at,
       fa.id                       AS assignment_id,
       fa.assignee_type            AS assignee_type,
       fa.workforce_profile_id     AS workforce_profile_id,
       fa.team_id                  AS team_id,
       fa.vendor_id                AS vendor_id,
       fa.assigned_by_user_id      AS assigned_by_user_id,
       fa.assigned_at              AS assigned_at
     ${fromClause}
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY f.source_id ASC, f.reported_at DESC, f.created_at DESC, f.id ASC
     ${limitClause}
     ${offsetClause}`,
    values,
  );

  return result.rows.map(mapRow);
}

export const operationalDetailFindingRepository = {
  getOperationalDetailFindingRows,
};

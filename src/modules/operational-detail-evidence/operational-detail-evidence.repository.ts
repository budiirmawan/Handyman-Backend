import { getPool } from '../../database';
import type { OperationalDetailEngine } from '../operational-detail-reporting/operational-detail-reporting.types';
import type {
  OperationalDetailEvidenceFilters,
  OperationalDetailEvidencePagination,
  PublicOperationalDetailEvidenceRow,
} from './operational-detail-evidence.types';

/**
 * R08 PART 01B — Operational Detail Evidence child projection (repository).
 *
 * ONE bounded set-based query, parent-driven exactly like the closed R04/R07
 * read models. ONE row per `evidence_submissions.id`. No per-execution loop, no
 * N+1, and no unbounded execution-id materialization: the authorized parent
 * population is expressed IN SQL, so no list of execution ids ever reaches
 * application memory.
 *
 * CLIENT CONSISTENCY IS STRUCTURAL (R08 PART 01A §5, §7 — decision A, fail-closed)
 *   `evidence_submissions.execution_id` carries NO FOREIGN KEY and nothing in the
 *   database ties `evidence_submissions.client_id` to the parent execution's
 *   client. The invariant is therefore enforced IN SQL, as part of the join
 *   predicate:
 *     e.execution_type = <engine>
 *     AND e.execution_id = parent.id
 *     AND e.client_id   = parent.client_id   ← mismatched rows are never fetched
 *   A mismatched-client row is EXCLUDED by construction — it is not included and
 *   flagged, it does not raise an error, it is not post-filtered after loading,
 *   and no caller-supplied clientId is ever consulted.
 *   The join cannot fan out: `parent.id` is a PRIMARY KEY, so each evidence row
 *   matches at most one parent row.
 *
 * BUILDING AUTHORITY (R08 PART 01A §6)
 *   Reuses the CLOSED R04/R07 building-resolution + access authority. Neither
 *   `checklist_executions` nor `form_instances` stores a building_id column, so
 *   resolution runs through the authoritative binding paths and is fail-closed:
 *   `<resolved building> = ANY($buildingIds)` evaluates to NULL (not TRUE) when no
 *   binding matches, so an execution whose building cannot be resolved is
 *   EXCLUDED, never guessed. `buildingIds` is produced by the service from
 *   buildingRepository.findById + contextAccessService.assertBuildingAccess, or
 *   contextAccessService.getAccessibleBuildingIds.
 *
 *   The parent drives the query so the authorized population is narrowed by the
 *   building scope and the half-open parent created_at window BEFORE evidence is
 *   reached, and building resolution is evaluated once per execution rather than
 *   once per evidence row.
 *
 *   The looser evidence-module `loadEvidenceExecution` seam is deliberately NOT
 *   used: it is client-scoped and skips the building assertion for
 *   CHECKLIST_EXECUTION (it selects NULL::uuid AS building_id) and for unbound
 *   FORM_INSTANCE.
 *
 *   PROVENANCE OF THE COPIED RESOLUTION SQL: no bounded parent-resolution
 *   authority is exported anywhere in the repository — R04's
 *   `getChecklistExecutionSummaryRows` is execution-grain but UNBOUNDED (no
 *   LIMIT), and R07's detail repositories are bounded but item/field-grain and
 *   are forbidden as a population source (R08 PART 01A §15). R08 PART 01B §9
 *   therefore authorises the fallback: the resolution fragments below are copied
 *   VERBATIM from checklist-execution-summary.repository.ts (the R04 authority)
 *   so ONE policy is expressed identically rather than a second policy being
 *   invented — the same precedent R07 PART 01A set for checklist-execution-detail.
 *
 * HISTORICAL VISIBILITY (R08 PART 01A §1)
 *   The DEFAULT read adds NO status predicate and NO retentionState predicate, so
 *   REMOVED and PURGED lineage rows are returned with their stored state
 *   verbatim. Both filters are optional and LITERAL.
 *
 * NO file_reference / storage column is selected — the projection lists explicit
 * columns and never `e.*`, so the storage key cannot leak into this contract.
 * No storage module is imported and no file bytes are touched.
 */

/**
 * R04 checklist-execution building-resolution authority — copied VERBATIM from
 * checklist-execution-summary.repository.ts (CE_BUILDING_SQL). Requires the
 * parent alias `ce`. Deterministic order:
 *   engineering_checklist_binding → inspection_binding →
 *   toilet_inspection_binding → public_area_inspection_binding →
 *   patrol_checklist_binding → vendor_checklist_binding →
 *   generated_task
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
 * `fi_base` CTE of checklist-execution-summary.repository.ts. Requires the
 * parent alias `fi`.
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

type EvidenceRow = {
  evidence_id: string;
  engine: string;
  execution_id: string;
  client_id: string;
  evidence_type: string;
  mime_type: string;
  original_file_name: string;
  file_size: string | number;
  captured_at: Date | null;
  created_at: Date;
  updated_at: Date | null;
  submitted_by_user_id: string | null;
  status: string;
  retention_state: string;
  evidence_requirement_id: string | null;
  content_sha256: string | null;
  content_hashed_at: Date | null;
  hash_algorithm: string | null;
  last_integrity_status: string | null;
  last_integrity_checked_at: Date | null;
  retention_policy_code: string | null;
  retention_days_snapshot: number | null;
  retention_applied_at: Date | null;
  retained_until: Date | null;
  retention_hold: boolean;
  purged_at: Date | null;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * Verbatim row mapping. Every value is copied as stored; NULLs are preserved and
 * never defaulted, coerced, or reinterpreted. No derived availability, integrity
 * or lifecycle field is produced, and `submittedByUserId` is never relabelled as
 * an executor.
 */
function mapRow(row: EvidenceRow): PublicOperationalDetailEvidenceRow {
  return {
    evidenceId: row.evidence_id,
    // engine is the R07 vocabulary value read back from execution_type verbatim
    engine: row.engine as OperationalDetailEngine,
    executionId: row.execution_id,
    clientId: row.client_id,

    evidenceType: row.evidence_type,
    mimeType: row.mime_type,
    originalFileName: row.original_file_name,
    fileSize: Number(row.file_size),

    capturedAt: toIso(row.captured_at),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at),
    submittedByUserId: row.submitted_by_user_id,

    // Two independent stored dimensions, verbatim — never inferred from each other
    status: row.status as PublicOperationalDetailEvidenceRow['status'],
    retentionState: row.retention_state as PublicOperationalDetailEvidenceRow['retentionState'],

    // Lineage metadata ONLY — never used to attribute an item/field/occurrence
    evidenceRequirementId: row.evidence_requirement_id,

    // contentSha256 NULL stays NULL and means NOT HASHED — never "verified"
    contentSha256: row.content_sha256,
    contentHashedAt: toIso(row.content_hashed_at),
    hashAlgorithm: row.hash_algorithm,
    lastIntegrityStatus: row.last_integrity_status as PublicOperationalDetailEvidenceRow['lastIntegrityStatus'],
    lastIntegrityCheckedAt: toIso(row.last_integrity_checked_at),

    retentionPolicyCode: row.retention_policy_code,
    retentionDaysSnapshot: row.retention_days_snapshot,
    retentionAppliedAt: toIso(row.retention_applied_at),
    retainedUntil: toIso(row.retained_until),
    retentionHold: row.retention_hold === true,
    purgedAt: toIso(row.purged_at),
  };
}

/**
 * ONE bounded query over evidence rows for the authorized parent population.
 *
 * Pagination is at EVIDENCE-ROW grain and is independent of any R07 detail page.
 * Deterministic total ordering: executionId ASC, createdAt ASC, evidenceId ASC
 * (`created_at` is NOT NULL so the order has no NULL ambiguity, and `id` is the
 * primary key so the order is total). Deliberately NOT ordered by capturedAt
 * (nullable device time) or updatedAt (mutated by retention and integrity runs).
 */
export async function getOperationalDetailEvidenceRows(
  buildingIds: string[],
  filters: OperationalDetailEvidenceFilters,
  start: Date | null,
  end: Date | null,
  pagination: OperationalDetailEvidencePagination,
): Promise<PublicOperationalDetailEvidenceRow[]> {
  const isChecklist = filters.engine === 'CHECKLIST_EXECUTION';
  const parentAlias = isChecklist ? 'ce' : 'fi';
  const parentTable = isChecklist ? 'checklist_executions ce' : 'form_instances fi';
  const buildingSql = isChecklist ? CE_BUILDING_SQL : FI_BUILDING_SQL;

  const values: unknown[] = [filters.engine, buildingIds];
  const conditions: string[] = [];

  // The version → parent-template chain is joined only when templateId is
  // filtered, matching the R07/R04 `templateId` = owning parent template semantic.
  const templateJoins =
    !isChecklist && filters.templateId
      ? `
       JOIN form_template_versions ftv ON ftv.id = ${parentAlias}.form_template_version_id
       JOIN form_templates ft ON ft.id = ftv.form_template_id`
      : '';

  // Parent-driven FROM. The client-consistency comparison is part of the JOIN
  // predicate, so a mismatched-client evidence row is never fetched at all.
  const fromClause = `
     FROM ${parentTable}${templateJoins}
     JOIN evidence_submissions e
       ON e.execution_type = $1
      AND e.execution_id = ${parentAlias}.id
      AND e.client_id = ${parentAlias}.client_id`;

  // R04/R07 building authority, fail-closed: an unresolvable building yields NULL,
  // and NULL = ANY(...) is not TRUE, so the execution is excluded.
  conditions.push(`${buildingSql} = ANY($2::uuid[])`);

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
  // R07/R04 population semantic. There is deliberately no competing
  // evidence-created_at population filter.
  if (start) {
    values.push(start);
    conditions.push(`${parentAlias}.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`${parentAlias}.created_at < $${values.length}`);
  }

  // DEFAULT read: NO status predicate and NO retentionState predicate, so REMOVED
  // and PURGED lineage rows remain visible. Both are OPTIONAL LITERAL filters over
  // the stored CHECK vocabularies, bound as parameters.
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`e.status = $${values.length}`);
  }
  if (filters.retentionState) {
    values.push(filters.retentionState);
    conditions.push(`e.retention_state = $${values.length}`);
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

  const result = await getPool().query<EvidenceRow>(
    `SELECT
       e.id                        AS evidence_id,
       e.execution_type            AS engine,
       e.execution_id              AS execution_id,
       e.client_id                 AS client_id,
       e.evidence_type             AS evidence_type,
       e.mime_type                 AS mime_type,
       e.original_file_name        AS original_file_name,
       e.file_size                 AS file_size,
       e.captured_at               AS captured_at,
       e.created_at                AS created_at,
       e.updated_at                AS updated_at,
       e.submitted_by_user_id      AS submitted_by_user_id,
       e.status                    AS status,
       e.retention_state           AS retention_state,
       e.evidence_requirement_id   AS evidence_requirement_id,
       e.content_sha256            AS content_sha256,
       e.content_hashed_at         AS content_hashed_at,
       e.hash_algorithm            AS hash_algorithm,
       e.last_integrity_status     AS last_integrity_status,
       e.last_integrity_checked_at AS last_integrity_checked_at,
       e.retention_policy_code     AS retention_policy_code,
       e.retention_days_snapshot   AS retention_days_snapshot,
       e.retention_applied_at      AS retention_applied_at,
       e.retained_until            AS retained_until,
       e.retention_hold            AS retention_hold,
       e.purged_at                 AS purged_at
     ${fromClause}
     WHERE ${conditions.join('\n       AND ')}
     ORDER BY e.execution_id ASC, e.created_at ASC, e.id ASC
     ${limitClause}
     ${offsetClause}`,
    values,
  );

  return result.rows.map(mapRow);
}

export const operationalDetailEvidenceRepository = {
  getOperationalDetailEvidenceRows,
};

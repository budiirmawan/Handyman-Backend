import { getPool } from '../../database';
import type {
  ChecklistExecutionDetailFilters,
  ChecklistExecutionDetailPagination,
  PublicChecklistExecutionDetailRow,
} from './checklist-execution-detail.types';

/**
 * R07 PART 01A — Checklist Detail Read Projection Core
 *
 * ONE ROW per (checklist_execution_id + checklist_item_id)
 * Model: checklist execution JOIN checklist_items LEFT JOIN checklist_item_responses
 *
 * R09 PART 01A — identification context via one additional 1:1 inner join:
 *   JOIN checklist_templates ct ON ct.id = ce_filtered.checklist_template_id
 *   (checklist_executions.checklist_template_id is NOT NULL with a PK FK,
 *    so the join cannot multiply rows nor drop rows; definitionCode is a
 *    column of the already-joined checklist_items row)
 *   definitionCode/templateCode/templateName are CURRENT master facts —
 *   NOT version snapshots; templateName is a CURRENT LIVE FACT.
 *
 * R09 PART 02A1 — UOM presentation via one read-only 0..1 LEFT JOIN with
 *   STRUCTURAL CLIENT EQUALITY (frozen R09 PART 02A-S rule; PK-only join is
 *   not structurally safe because checklist_items.uom_id is a plain FK and
 *   cross-client attachment is possible in persisted data):
 *   LEFT JOIN units_of_measure uom
 *     ON uom.id = ci.uom_id
 *    AND uom.client_id = ce_filtered.client_id
 *   uomName/uomSymbol are CURRENT LIVE FACTS (mutable master, no snapshot);
 *   NULL when uom_id is NULL or the UOM belongs to another client (fail-closed:
 *   row remains, uomId unchanged, label resolves NULL).
 *
 * R09 PART 02B1 — actor presentation via THREE independent 0..1 PK LEFT JOINs
 *   on the global users identity master (users has NO client_id; the persisted
 *   actor UUIDs are already authorized facts of this population):
 *   LEFT JOIN users cbu ON cbu.id = ce_filtered.completed_by_user_id
 *   LEFT JOIN users lru ON lru.id = r.last_responded_by_user_id
 *   LEFT JOIN users vru ON vru.id = vr.reviewer_user_id
 *   No status predicate (INACTIVE/SUSPENDED users remain resolvable), no
 *   client/membership predicate. CURRENT LIVE FACTS, NOT snapshots;
 *   fail-closed NULL when the actor ID is NULL or unresolved (row remains,
 *   actor ID unchanged).
 *
 * R09 PART 02C1 — assignment-target presentation via two independent 0..1
 *   client-lineage-qualified LEFT JOINs on the persisted R06 assignment IDs:
 *   workforce_profiles.full_name is resolved only when the exact profile's
 *   organization.client_id equals ce_filtered.client_id; teams.name is
 *   resolved only when the exact team's department.organization.client_id
 *   equals ce_filtered.client_id. CURRENT LIVE FACTS, NOT assignment
 *   snapshots and NOT actual-executor facts. Unresolved or cross-client
 *   targets preserve the persisted ID and return a NULL name; no status gate.
 *
 * Reuses R04 building-resolution authority verbatim (fail-closed).
 * No evidence/finding/rework/form joins. No N+1. Single bounded query.
 *
 * NULL / UNANSWERED contract:
 *   - No response row => responseId NULL, value NULL, result NULL, notes NULL,
 *     isNa FALSE, naNotes NULL, responseCreatedAt NULL, responseUpdatedAt NULL,
 *     lastRespondedByUserId NULL, optionCode NULL, optionLabel NULL
 *   - Row still exists in projection (LEFT JOIN)
 *
 * EXPLICIT N/A contract:
 *   - is_na TRUE => responseId NOT NULL, isNa TRUE, value NULL, result NULL,
 *     naNotes stored, lastRespondedByUserId stored
 *
 * LEGACY NULL:
 *   - is_na FALSE remains non-N/A even if value/result NULL
 *
 * SELECT contract:
 *   - optionCode = canonical stored code (r.value #>> '{}') when SELECT and not N/A
 *   - optionLabel = CURRENT checklist_item_options.label (LIVE, not historical)
 *   - Historical INACTIVE options remain readable (no status filter on read)
 *
 * HISTORICAL SAFETY:
 *   STABLE: response row facts, option code, completion actor, assignment snapshot,
 *           latest writer, review facts
 *   LIVE: itemLabel, itemType, displayOrder, required, uomId, min/max/precision,
 *         isNaAllowed, naRequiresNote, optionLabel
 *   R09 PART 01A CURRENT master facts (NOT snapshots):
 *         definitionCode (checklist_items.code), templateCode, templateName
 *   R09 PART 02A1 CURRENT LIVE FACTS (NOT snapshots; NULL on NULL uom_id or
 *         client mismatch — fail-closed):
 *         uomName (units_of_measure.name), uomSymbol (units_of_measure.symbol)
 *   R09 PART 02B1 CURRENT LIVE FACTS (NOT snapshots; NULL on NULL/unresolved
 *         actor ID — fail-closed):
 *         completedByName, lastRespondedByName, verificationReviewerName
 *         (users.display_name via PK LEFT JOIN on the global identity master)
 */

type RegisterRow = {
  execution_id: string;
  checklist_item_id: string;
  response_id: string | null;
  client_id: string;
  building_id: string;
  template_id: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  execution_created_at: Date;
  execution_updated_at: Date;
  definition_code: string;
  template_code: string;
  template_name: string;
  item_label: string;
  item_type: string;
  display_order: number;
  required: boolean;
  uom_id: string | null;
  uom_name: string | null;
  uom_symbol: string | null;
  minimum_value: string | null;
  maximum_value: string | null;
  decimal_precision: number | null;
  is_na_allowed: boolean;
  na_requires_note: boolean;
  value: unknown | null;
  result: string | null;
  notes: string | null;
  is_na: boolean | null;
  na_notes: string | null;
  response_created_at: Date | null;
  response_updated_at: Date | null;
  last_responded_by_user_id: string | null;
  last_responded_by_name: string | null;
  completed_by_user_id: string | null;
  completed_by_name: string | null;
  assignee_type: string | null;
  assigned_workforce_profile_id: string | null;
  assigned_workforce_name: string | null;
  assigned_team_id: string | null;
  assigned_team_name: string | null;
  assignment_snapshot_at: Date | null;
  verification_review_id: string | null;
  verification_status: string | null;
  verification_decision: string | null;
  verification_reviewer_user_id: string | null;
  verification_reviewer_name: string | null;
  verification_reviewed_at: Date | null;
  option_code: string | null;
  option_label: string | null;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * R04 building-resolution authority — copied verbatim from
 * checklist-execution-summary.repository.ts to avoid second policy.
 * Fail-closed: NULL building excluded.
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

function mapRow(row: RegisterRow): PublicChecklistExecutionDetailRow {
  // isNa: FALSE when unanswered (r.is_na NULL), TRUE only when explicit N/A row
  const isNa = row.is_na === true;

  // optionCode: canonical stored code when SELECT and not N/A and response exists
  // Already computed in SQL as option_code, but ensure NULL when isNa
  const optionCode = isNa ? null : row.option_code;
  const optionLabel = isNa ? null : row.option_label;

  // value: preserve native JSONB exactly, but force NULL when isNa (SQL already NULL)
  // Legacy NULL: is_na FALSE remains non-N/A even if value NULL
  const value = isNa ? null : row.value;

  // result: force NULL when isNa per explicit N/A contract
  const result = isNa ? null : row.result;

  return {
    executionId: row.execution_id,
    checklistItemId: row.checklist_item_id,
    responseId: row.response_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    templateId: row.template_id,
    status: row.status,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    createdAt: row.execution_created_at.toISOString(),
    updatedAt: row.execution_updated_at.toISOString(),
    definitionCode: row.definition_code,
    templateCode: row.template_code,
    templateName: row.template_name,
    itemLabel: row.item_label,
    itemType: row.item_type as PublicChecklistExecutionDetailRow['itemType'],
    displayOrder: row.display_order,
    required: row.required,
    uomId: row.uom_id,
    uomName: row.uom_name,
    uomSymbol: row.uom_symbol,
    minimumValue: row.minimum_value,
    maximumValue: row.maximum_value,
    decimalPrecision: row.decimal_precision,
    isNaAllowed: row.is_na_allowed,
    naRequiresNote: row.na_requires_note,
    value,
    result,
    notes: row.notes,
    isNa,
    naNotes: row.na_notes,
    responseCreatedAt: toIso(row.response_created_at),
    responseUpdatedAt: toIso(row.response_updated_at),
    lastRespondedByUserId: row.last_responded_by_user_id,
    lastRespondedByName: row.last_responded_by_name,
    completedByUserId: row.completed_by_user_id,
    completedByName: row.completed_by_name,
    assigneeType: row.assignee_type,
    assignedWorkforceProfileId: row.assigned_workforce_profile_id,
    assignedWorkforceName: row.assigned_workforce_name,
    assignedTeamId: row.assigned_team_id,
    assignedTeamName: row.assigned_team_name,
    assignmentSnapshotAt: toIso(row.assignment_snapshot_at),
    verificationReviewId: row.verification_review_id,
    verificationStatus: row.verification_status,
    verificationDecision: row.verification_decision,
    verificationReviewerUserId: row.verification_reviewer_user_id,
    verificationReviewerName: row.verification_reviewer_name,
    verificationReviewedAt: toIso(row.verification_reviewed_at),
    optionCode,
    optionLabel,
  };
}

export async function getChecklistExecutionDetailRows(
  buildingIds: string[],
  filters: ChecklistExecutionDetailFilters,
  start: Date | null,
  end: Date | null,
  pagination: ChecklistExecutionDetailPagination = {},
): Promise<PublicChecklistExecutionDetailRow[]> {
  const conditions: string[] = ['ce_filtered.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];
  let paramIndex = values.length;

  // building_id fail-closed already handled in CTE (IS NOT NULL), but also keep condition
  // to ensure scope.

  if (filters.executionId) {
    paramIndex++;
    values.push(filters.executionId);
    conditions.push(`ce_filtered.id = $${paramIndex}::uuid`);
  }
  if (filters.templateId) {
    paramIndex++;
    values.push(filters.templateId);
    conditions.push(`ce_filtered.checklist_template_id = $${paramIndex}::uuid`);
  }
  if (filters.status) {
    paramIndex++;
    values.push(filters.status);
    conditions.push(`ce_filtered.status = $${paramIndex}`);
  }
  if (start) {
    paramIndex++;
    values.push(start);
    conditions.push(`ce_filtered.created_at >= $${paramIndex}`);
  }
  if (end) {
    paramIndex++;
    values.push(end);
    conditions.push(`ce_filtered.created_at < $${paramIndex}`);
  }

  // Pagination
  let limitClause = '';
  let offsetClause = '';
  if (pagination.limit !== undefined) {
    paramIndex++;
    values.push(pagination.limit);
    limitClause = `LIMIT $${paramIndex}`;
  }
  if (pagination.offset !== undefined) {
    paramIndex++;
    values.push(pagination.offset);
    offsetClause = `OFFSET $${paramIndex}`;
  }

  // If no explicit limit, set a bounded default to avoid unbounded reads (optional)
  // But spec says bounded pagination exists — we allow no limit for flexibility,
  // caller should pass limit. We do not enforce default here to keep query minimal.

  const sql = `
    WITH ce_base AS (
      SELECT
        ce.id,
        ce.client_id,
        ce.checklist_template_id,
        ce.status,
        ce.started_at,
        ce.completed_at,
        ce.created_at,
        ce.updated_at,
        ce.completed_by_user_id,
        ce.assignee_type,
        ce.assigned_workforce_profile_id,
        ce.assigned_team_id,
        ce.assignment_snapshot_at,
        ce.engineering_checklist_binding_id,
        ce.inspection_binding_id,
        ce.toilet_inspection_binding_id,
        ce.public_area_inspection_binding_id,
        ce.patrol_checklist_binding_id,
        ce.generated_task_id,
        ${CE_BUILDING_SQL} AS building_id
      FROM checklist_executions ce
    ),
    ce_filtered AS (
      SELECT * FROM ce_base WHERE building_id IS NOT NULL
    )
    SELECT
      ce_filtered.id AS execution_id,
      ci.id AS checklist_item_id,
      r.id AS response_id,
      ce_filtered.client_id,
      ce_filtered.building_id,
      ce_filtered.checklist_template_id AS template_id,
      ce_filtered.status,
      ce_filtered.started_at,
      ce_filtered.completed_at,
      ce_filtered.created_at AS execution_created_at,
      ce_filtered.updated_at AS execution_updated_at,
      ci.code AS definition_code,
      ct.code AS template_code,
      ct.name AS template_name,
      ci.label AS item_label,
      ci.item_type,
      ci.display_order,
      ci.required,
      ci.uom_id,
      uom.name AS uom_name,
      uom.symbol AS uom_symbol,
      ci.minimum_value::text AS minimum_value,
      ci.maximum_value::text AS maximum_value,
      ci.decimal_precision,
      ci.is_na_allowed,
      ci.na_requires_note,
      r.value AS value,
      r.result AS result,
      r.notes AS notes,
      r.is_na AS is_na,
      r.na_notes AS na_notes,
      r.created_at AS response_created_at,
      r.updated_at AS response_updated_at,
      r.last_responded_by_user_id,
      lru.display_name AS last_responded_by_name,
      ce_filtered.completed_by_user_id,
      cbu.display_name AS completed_by_name,
      ce_filtered.assignee_type,
      ce_filtered.assigned_workforce_profile_id,
      awp.full_name AS assigned_workforce_name,
      ce_filtered.assigned_team_id,
      assigned_team.name AS assigned_team_name,
      ce_filtered.assignment_snapshot_at,
      vr.id AS verification_review_id,
      vr.status AS verification_status,
      vr.decision AS verification_decision,
      vr.reviewer_user_id AS verification_reviewer_user_id,
      vru.display_name AS verification_reviewer_name,
      vr.reviewed_at AS verification_reviewed_at,
      CASE
        WHEN ci.item_type = 'SELECT' AND r.id IS NOT NULL AND COALESCE(r.is_na, false) = false AND r.value IS NOT NULL
        THEN r.value #>> '{}'
        ELSE NULL
      END AS option_code,
      cio.label AS option_label
    FROM ce_filtered
    JOIN checklist_items ci
      ON ci.checklist_template_id = ce_filtered.checklist_template_id
    JOIN checklist_templates ct
      ON ct.id = ce_filtered.checklist_template_id
    LEFT JOIN checklist_item_responses r
      ON r.checklist_execution_id = ce_filtered.id
     AND r.checklist_item_id = ci.id
    /* R09 PART 02A1 — UOM presentation: 0..1 (PK join) with structural client
       equality; fail-closed NULL on NULL uom_id or cross-client UOM */
    LEFT JOIN units_of_measure uom
      ON uom.id = ci.uom_id
     AND uom.client_id = ce_filtered.client_id
    /* R09 PART 02C1 — assignment-target presentation: each name-bearing
       row is itself client-lineage-qualified, so cross-client IDs fail closed
       without changing the persisted assignment IDs or parent row. */
    LEFT JOIN workforce_profiles awp
      ON awp.id = ce_filtered.assigned_workforce_profile_id
     AND EXISTS (
       SELECT 1
         FROM organizations awp_org
        WHERE awp_org.id = awp.organization_id
          AND awp_org.client_id = ce_filtered.client_id
     )
    LEFT JOIN teams assigned_team
      ON assigned_team.id = ce_filtered.assigned_team_id
     AND EXISTS (
       SELECT 1
         FROM departments assigned_department
         JOIN organizations assigned_organization
           ON assigned_organization.id = assigned_department.organization_id
        WHERE assigned_department.id = assigned_team.department_id
          AND assigned_organization.client_id = ce_filtered.client_id
     )
    LEFT JOIN checklist_item_options cio
      ON cio.checklist_item_id = ci.id
     AND cio.code = (r.value #>> '{}')
    LEFT JOIN LATERAL (
      SELECT id, status, decision, reviewer_user_id, reviewed_at
        FROM reviews
       WHERE target_type = 'CHECKLIST_EXECUTION'
         AND target_id = ce_filtered.id
         AND status = 'COMPLETED'
       ORDER BY reviewed_at DESC, created_at DESC, id DESC
       LIMIT 1
    ) vr ON TRUE
    /* R09 PART 02B1 — actor presentation: three independent 0..1 PK LEFT JOINs
       on the global users identity master; no status/client/membership
       predicate; fail-closed NULL on NULL or unresolved actor ID */
    LEFT JOIN users cbu
      ON cbu.id = ce_filtered.completed_by_user_id
    LEFT JOIN users lru
      ON lru.id = r.last_responded_by_user_id
    LEFT JOIN users vru
      ON vru.id = vr.reviewer_user_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY ce_filtered.created_at DESC, ce_filtered.id ASC, ci.display_order ASC, ci.id ASC
    ${limitClause}
    ${offsetClause}
  `;

  const result = await getPool().query<RegisterRow>(sql, values);
  return result.rows.map(mapRow);
}

export const checklistExecutionDetailRepository = {
  getChecklistExecutionDetailRows,
};

import { getPool } from '../../database';
import type {
  FormExecutionDetailFilters,
  FormExecutionDetailPagination,
  PublicFormExecutionDetailRow,
} from './form-execution-detail.types';

/**
 * R07 PART 02B — Form Detail Repository Core
 *
 * Grain: ONE ROW per (form_instance_id + version_field_id + occurrence identity)
 *   Non-repeatable: occurrenceId NULL, occurrenceIndex NULL
 *   Repeatable: occurrenceId = form_instance_occurrences.id, occurrenceIndex = occurrence_index
 *
 * Repeatable group authority: form_repeatable_groups determines whether version section is repeatable.
 * Occurrence join scoped by current instance + repeatable group belonging to current version section.
 * No cross-section Cartesian product.
 *
 * Empty occurrence: occurrence row exists with no response yet => row still exists, responseId NULL, value NULL, occurrenceId/index populated.
 * Non-repeatable unanswered: occurrence NULL, responseId NULL, value NULL, row still exists.
 * NULL value response: responseId != NULL AND value NULL distinct from unanswered (responseId NULL).
 *
 * Version snapshot metadata from form_template_version_sections/fields (STABLE).
 * Live measurement metadata from live form_fields via field_id (LIVE).
 *
 * R09 PART 01B — identification context, SELECT-only additions (NO new joins):
 *   definitionCode = vf.code (STABLE VERSION SNAPSHOT; same authority as fieldCode)
 *   templateCode   = ft.code, templateName = ft.name (CURRENT form_templates master)
 *   The ft / vf joins already exist in both UNION branches and are 1:1
 *   (form_instances.form_template_version_id NOT NULL -> version PK;
 *    version.form_template_id NOT NULL -> template PK; version field belongs
 *    to exactly one version section -> one version), so the additions cannot
 *    multiply or drop rows. The version lineage persists no template
 *   code/name snapshot, so template identity comes from the current master.
 *
 * R09 PART 02A2 — UOM presentation via one read-only 0..1 LEFT JOIN per UNION
 *   branch with STRUCTURAL CLIENT EQUALITY (frozen R09 PART 02A-S rule; PK-only
 *   join is not structurally safe because form_fields.uom_id is a plain FK and
 *   cross-client attachment is possible in persisted data):
 *   LEFT JOIN units_of_measure uom
 *     ON uom.id = ff.uom_id
 *    AND uom.client_id = fi_filtered.client_id
 *   uomName/uomSymbol are CURRENT LIVE FACTS (mutable master, no snapshot);
 *   NULL when uom_id is NULL or the UOM belongs to another client (fail-closed:
 *   row remains, uomId unchanged, label resolves NULL).
 *
 * R09 PART 02B2 — actor presentation via THREE independent 0..1 PK LEFT JOINs
 *   per UNION branch (six total) on the global users identity master (users
 *   has NO client_id; the persisted actor UUIDs are already authorized facts
 *   of this population):
 *   LEFT JOIN users cbu ON cbu.id = fi_filtered.completed_by_user_id
 *   LEFT JOIN users lru ON lru.id = r.last_responded_by_user_id
 *   LEFT JOIN users vru ON vru.id = vr.reviewer_user_id
 *   No status predicate (INACTIVE/SUSPENDED users remain resolvable), no
 *   client/membership predicate. CURRENT LIVE FACTS, NOT snapshots;
 *   fail-closed NULL when the actor ID is NULL or unresolved (row remains,
 *   actor ID unchanged).
 *
 * R09 PART 02C2 — assignment-target presentation via two independent 0..1
 *   client-lineage-qualified LEFT JOIN pairs, repeated independently in both
 *   UNION branches, on the persisted R06 assignment IDs:
 *   workforce_profiles.full_name is resolved only when the exact profile's
 *   organization.client_id equals fi_filtered.client_id; teams.name is
 *   resolved only when the exact team's department.organization.client_id
 *   equals fi_filtered.client_id. CURRENT LIVE FACTS, NOT historical
 *   assignment snapshots and NOT actual-executor facts. Unresolved or
 *   cross-client targets preserve the persisted ID and return a NULL name;
 *   no status gate.
 * No result/notes/isNa/naNotes, no SELECT option table, no evidence/finding/rework, no checklist engine.
 * Building authority reused verbatim from R04 FORM_INSTANCE path (meter -> log -> generated_task, fail-closed).
 * One bounded query, no per-row loop.
 */

type RegisterRow = {
  form_instance_id: string;
  version_field_id: string;
  occurrence_id: string | null;
  occurrence_index: number | null;
  response_id: string | null;
  client_id: string;
  building_id: string;
  form_template_id: string;
  form_template_version_id: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  instance_created_at: Date;
  instance_updated_at: Date;
  definition_code: string;
  template_code: string;
  template_name: string;
  section_id: string;
  section_code: string;
  section_title: string;
  section_display_order: number;
  section_status: string;
  field_code: string;
  field_label: string;
  field_type: string;
  required: boolean;
  display_order: number;
  field_status: string;
  uom_id: string | null;
  uom_name: string | null;
  uom_symbol: string | null;
  minimum_value: string | null;
  maximum_value: string | null;
  decimal_precision: number | null;
  value: unknown | null;
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
  repeatable_group_id: string | null;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/**
 * R04 FORM_INSTANCE building-resolution authority — copied verbatim from
 * checklist-execution-summary.repository.ts fi_base CTE.
 * Fail-closed: NULL building excluded.
 */
const FI_BUILDING_SQL = `
  COALESCE(
    (SELECT mrb.building_id FROM meter_reading_bindings mrb WHERE mrb.id = fi.meter_reading_binding_id),
    (SELECT lsb.building_id FROM log_sheet_bindings lsb WHERE lsb.id = fi.log_sheet_binding_id),
    (SELECT gt.building_id FROM generated_tasks gt WHERE gt.id = fi.generated_task_id AND gt.building_id IS NOT NULL),
    NULL
  )
`;

function mapRow(row: RegisterRow): PublicFormExecutionDetailRow {
  return {
    formInstanceId: row.form_instance_id,
    versionFieldId: row.version_field_id,
    occurrenceId: row.occurrence_id,
    occurrenceIndex: row.occurrence_index,
    responseId: row.response_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    formTemplateId: row.form_template_id,
    formTemplateVersionId: row.form_template_version_id,
    status: row.status,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    createdAt: row.instance_created_at.toISOString(),
    updatedAt: row.instance_updated_at.toISOString(),
    definitionCode: row.definition_code,
    templateCode: row.template_code,
    templateName: row.template_name,
    sectionId: row.section_id,
    sectionCode: row.section_code,
    sectionTitle: row.section_title,
    sectionDisplayOrder: row.section_display_order,
    sectionStatus: row.section_status,
    fieldCode: row.field_code,
    fieldLabel: row.field_label,
    fieldType: row.field_type as PublicFormExecutionDetailRow['fieldType'],
    required: row.required,
    displayOrder: row.display_order,
    fieldStatus: row.field_status,
    uomId: row.uom_id,
    uomName: row.uom_name,
    uomSymbol: row.uom_symbol,
    minimumValue: row.minimum_value,
    maximumValue: row.maximum_value,
    decimalPrecision: row.decimal_precision,
    value: row.value,
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
    repeatableGroupId: row.repeatable_group_id,
  };
}

export async function getFormExecutionDetailRows(
  buildingIds: string[],
  filters: FormExecutionDetailFilters,
  start: Date | null,
  end: Date | null,
  pagination: FormExecutionDetailPagination = {},
): Promise<PublicFormExecutionDetailRow[]> {
  const conditions: string[] = ['fi_filtered.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];
  let paramIndex = values.length;

  if (filters.formInstanceId) {
    paramIndex++;
    values.push(filters.formInstanceId);
    conditions.push(`fi_filtered.id = $${paramIndex}::uuid`);
  }
  if (filters.formTemplateId) {
    paramIndex++;
    values.push(filters.formTemplateId);
    conditions.push(`ft.id = $${paramIndex}::uuid`);
  }
  if (filters.status) {
    paramIndex++;
    values.push(filters.status);
    conditions.push(`fi_filtered.status = $${paramIndex}`);
  }
  if (start) {
    paramIndex++;
    values.push(start);
    conditions.push(`fi_filtered.created_at >= $${paramIndex}`);
  }
  if (end) {
    paramIndex++;
    values.push(end);
    conditions.push(`fi_filtered.created_at < $${paramIndex}`);
  }

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

  const sql = `
    WITH fi_base AS (
      SELECT
        fi.id,
        fi.client_id,
        fi.form_template_version_id,
        fi.status,
        fi.started_at,
        fi.completed_at,
        fi.created_at,
        fi.updated_at,
        fi.completed_by_user_id,
        fi.assignee_type,
        fi.assigned_workforce_profile_id,
        fi.assigned_team_id,
        fi.assignment_snapshot_at,
        fi.meter_reading_binding_id,
        fi.log_sheet_binding_id,
        fi.generated_task_id,
        ${FI_BUILDING_SQL} AS building_id
      FROM form_instances fi
    ),
    fi_filtered AS (
      SELECT * FROM fi_base WHERE building_id IS NOT NULL
    )
    SELECT
      fi_filtered.id AS form_instance_id,
      vf.id AS version_field_id,
      occ.id AS occurrence_id,
      occ.occurrence_index AS occurrence_index,
      r.id AS response_id,
      fi_filtered.client_id,
      fi_filtered.building_id,
      ft.id AS form_template_id,
      fi_filtered.form_template_version_id,
      fi_filtered.status,
      fi_filtered.started_at,
      fi_filtered.completed_at,
      fi_filtered.created_at AS instance_created_at,
      fi_filtered.updated_at AS instance_updated_at,
      vf.code AS definition_code,
      ft.code AS template_code,
      ft.name AS template_name,
      vs.id AS section_id,
      vs.code AS section_code,
      vs.title AS section_title,
      vs.display_order AS section_display_order,
      vs.status AS section_status,
      vf.code AS field_code,
      vf.label AS field_label,
      vf.field_type,
      vf.required,
      vf.display_order,
      vf.status AS field_status,
      ff.uom_id,
      uom.name AS uom_name,
      uom.symbol AS uom_symbol,
      ff.minimum_value::text AS minimum_value,
      ff.maximum_value::text AS maximum_value,
      ff.decimal_precision,
      r.value AS value,
      r.created_at AS response_created_at,
      r.updated_at AS response_updated_at,
      r.last_responded_by_user_id,
      lru.display_name AS last_responded_by_name,
      fi_filtered.completed_by_user_id,
      cbu.display_name AS completed_by_name,
      fi_filtered.assignee_type,
      fi_filtered.assigned_workforce_profile_id,
      awp.full_name AS assigned_workforce_name,
      fi_filtered.assigned_team_id,
      assigned_team.name AS assigned_team_name,
      fi_filtered.assignment_snapshot_at,
      vr.id AS verification_review_id,
      vr.status AS verification_status,
      vr.decision AS verification_decision,
      vr.reviewer_user_id AS verification_reviewer_user_id,
      vru.display_name AS verification_reviewer_name,
      vr.reviewed_at AS verification_reviewed_at,
      rg.id AS repeatable_group_id
    FROM fi_filtered
    JOIN form_template_versions v ON v.id = fi_filtered.form_template_version_id
    JOIN form_templates ft ON ft.id = v.form_template_id
    JOIN form_template_version_sections vs ON vs.version_id = v.id
    JOIN form_template_version_fields vf ON vf.version_section_id = vs.id
    LEFT JOIN form_repeatable_groups rg ON rg.version_section_id = vs.id
    /* Non-repeatable branch: rg IS NULL, no occurrence expansion, response occurrence_id IS NULL */
    LEFT JOIN form_responses r ON
      r.form_instance_id = fi_filtered.id
      AND r.version_field_id = vf.id
      AND r.occurrence_id IS NULL
    LEFT JOIN form_fields ff ON ff.id = vf.field_id
    /* R09 PART 02A2 — UOM presentation: 0..1 (PK join) with structural client
       equality; fail-closed NULL on NULL uom_id or cross-client UOM */
    LEFT JOIN units_of_measure uom
      ON uom.id = ff.uom_id
     AND uom.client_id = fi_filtered.client_id
    /* R09 PART 02C2 — assignment-target presentation: each name-bearing
       row is itself client-lineage-qualified, so cross-client IDs fail closed
       without changing persisted assignment IDs or form occurrences. */
    LEFT JOIN workforce_profiles awp
      ON awp.id = fi_filtered.assigned_workforce_profile_id
     AND EXISTS (
       SELECT 1
         FROM organizations awp_org
        WHERE awp_org.id = awp.organization_id
          AND awp_org.client_id = fi_filtered.client_id
     )
    LEFT JOIN teams assigned_team
      ON assigned_team.id = fi_filtered.assigned_team_id
     AND EXISTS (
       SELECT 1
         FROM departments assigned_department
         JOIN organizations assigned_organization
           ON assigned_organization.id = assigned_department.organization_id
        WHERE assigned_department.id = assigned_team.department_id
          AND assigned_organization.client_id = fi_filtered.client_id
     )
    LEFT JOIN LATERAL (
      SELECT id, status, decision, reviewer_user_id, reviewed_at
        FROM reviews
       WHERE target_type = 'FORM_INSTANCE'
         AND target_id = fi_filtered.id
         AND status = 'COMPLETED'
       ORDER BY reviewed_at DESC, created_at DESC, id DESC
       LIMIT 1
    ) vr ON TRUE
    /* R09 PART 02B2 — actor presentation: three independent 0..1 PK LEFT JOINs
       on the global users identity master; no status/client/membership
       predicate; fail-closed NULL on NULL or unresolved actor ID */
    LEFT JOIN users cbu
      ON cbu.id = fi_filtered.completed_by_user_id
    LEFT JOIN users lru
      ON lru.id = r.last_responded_by_user_id
    LEFT JOIN users vru
      ON vru.id = vr.reviewer_user_id
    /* Occurrence placeholder for non-repeatable: NULL */
    LEFT JOIN LATERAL (SELECT NULL::uuid AS id, NULL::int AS occurrence_index) occ ON rg.id IS NULL
    WHERE rg.id IS NULL AND ${conditions.join(' AND ')}

    UNION ALL

    SELECT
      fi_filtered.id AS form_instance_id,
      vf.id AS version_field_id,
      occ.id AS occurrence_id,
      occ.occurrence_index AS occurrence_index,
      r.id AS response_id,
      fi_filtered.client_id,
      fi_filtered.building_id,
      ft.id AS form_template_id,
      fi_filtered.form_template_version_id,
      fi_filtered.status,
      fi_filtered.started_at,
      fi_filtered.completed_at,
      fi_filtered.created_at AS instance_created_at,
      fi_filtered.updated_at AS instance_updated_at,
      vf.code AS definition_code,
      ft.code AS template_code,
      ft.name AS template_name,
      vs.id AS section_id,
      vs.code AS section_code,
      vs.title AS section_title,
      vs.display_order AS section_display_order,
      vs.status AS section_status,
      vf.code AS field_code,
      vf.label AS field_label,
      vf.field_type,
      vf.required,
      vf.display_order,
      vf.status AS field_status,
      ff.uom_id,
      uom.name AS uom_name,
      uom.symbol AS uom_symbol,
      ff.minimum_value::text AS minimum_value,
      ff.maximum_value::text AS maximum_value,
      ff.decimal_precision,
      r.value AS value,
      r.created_at AS response_created_at,
      r.updated_at AS response_updated_at,
      r.last_responded_by_user_id,
      lru.display_name AS last_responded_by_name,
      fi_filtered.completed_by_user_id,
      cbu.display_name AS completed_by_name,
      fi_filtered.assignee_type,
      fi_filtered.assigned_workforce_profile_id,
      awp.full_name AS assigned_workforce_name,
      fi_filtered.assigned_team_id,
      assigned_team.name AS assigned_team_name,
      fi_filtered.assignment_snapshot_at,
      vr.id AS verification_review_id,
      vr.status AS verification_status,
      vr.decision AS verification_decision,
      vr.reviewer_user_id AS verification_reviewer_user_id,
      vru.display_name AS verification_reviewer_name,
      vr.reviewed_at AS verification_reviewed_at,
      rg.id AS repeatable_group_id
    FROM fi_filtered
    JOIN form_template_versions v ON v.id = fi_filtered.form_template_version_id
    JOIN form_templates ft ON ft.id = v.form_template_id
    JOIN form_template_version_sections vs ON vs.version_id = v.id
    JOIN form_template_version_fields vf ON vf.version_section_id = vs.id
    JOIN form_repeatable_groups rg ON rg.version_section_id = vs.id
    /* Repeatable branch: occurrences scoped by instance + repeatable_group belonging to current section */
    JOIN form_instance_occurrences occ ON occ.form_instance_id = fi_filtered.id AND occ.repeatable_group_id = rg.id
    LEFT JOIN form_responses r ON
      r.form_instance_id = fi_filtered.id
      AND r.version_field_id = vf.id
      AND r.occurrence_id = occ.id
    LEFT JOIN form_fields ff ON ff.id = vf.field_id
    /* R09 PART 02A2 — UOM presentation: 0..1 (PK join) with structural client
       equality; fail-closed NULL on NULL uom_id or cross-client UOM */
    LEFT JOIN units_of_measure uom
      ON uom.id = ff.uom_id
     AND uom.client_id = fi_filtered.client_id
    /* R09 PART 02C2 — assignment-target presentation: each name-bearing
       row is itself client-lineage-qualified, so cross-client IDs fail closed
       without changing persisted assignment IDs or form occurrences. */
    LEFT JOIN workforce_profiles awp
      ON awp.id = fi_filtered.assigned_workforce_profile_id
     AND EXISTS (
       SELECT 1
         FROM organizations awp_org
        WHERE awp_org.id = awp.organization_id
          AND awp_org.client_id = fi_filtered.client_id
     )
    LEFT JOIN teams assigned_team
      ON assigned_team.id = fi_filtered.assigned_team_id
     AND EXISTS (
       SELECT 1
         FROM departments assigned_department
         JOIN organizations assigned_organization
           ON assigned_organization.id = assigned_department.organization_id
        WHERE assigned_department.id = assigned_team.department_id
          AND assigned_organization.client_id = fi_filtered.client_id
     )
    LEFT JOIN LATERAL (
      SELECT id, status, decision, reviewer_user_id, reviewed_at
        FROM reviews
       WHERE target_type = 'FORM_INSTANCE'
         AND target_id = fi_filtered.id
         AND status = 'COMPLETED'
       ORDER BY reviewed_at DESC, created_at DESC, id DESC
       LIMIT 1
    ) vr ON TRUE
    /* R09 PART 02B2 — actor presentation: three independent 0..1 PK LEFT JOINs
       on the global users identity master; no status/client/membership
       predicate; fail-closed NULL on NULL or unresolved actor ID */
    LEFT JOIN users cbu
      ON cbu.id = fi_filtered.completed_by_user_id
    LEFT JOIN users lru
      ON lru.id = r.last_responded_by_user_id
    LEFT JOIN users vru
      ON vru.id = vr.reviewer_user_id
    WHERE ${conditions.join(' AND ')}

    ORDER BY instance_created_at DESC, form_instance_id ASC, section_display_order ASC, section_id ASC, occurrence_index ASC NULLS FIRST, display_order ASC, version_field_id ASC
    ${limitClause}
    ${offsetClause}
  `;

  const result = await getPool().query<RegisterRow>(sql, values);
  return result.rows.map(mapRow);
}

export const formExecutionDetailRepository = {
  getFormExecutionDetailRows,
};

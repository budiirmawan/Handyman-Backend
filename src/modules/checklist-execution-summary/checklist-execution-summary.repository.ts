import { getPool } from '../../database';
import type {
  ChecklistExecutionSummaryFilters,
  PublicChecklistExecutionSummaryRow,
} from './checklist-execution-summary.types';

/**
 * CR-BE-REPORT-READ-04 PART 01 — Checklist Execution Summary repository.
 *
 * One read-only statement unifying BE-07's two execution engines
 * (`checklist_executions` and `form_instances`) at the summary grain.
 * Engine-specific CTEs resolve building / asset / functional-location /
 * vendor context through each engine's authoritative binding columns.
 * Rows whose Building cannot be resolved are excluded (fail-closed),
 * never guessed.
 *
 * Building resolution invariants relied on:
 *   - Each domain binding (engineering / patrol / inspection / toilet /
 *     public-area / vendor-checklist / meter-reading / log-sheet) has
 *     its own nullable FK on the execution row and is populated only
 *     by that domain's creation flow, so multiple non-NULL binding FKs
 *     on a single row do not occur in practice. COALESCE across those
 *     columns is therefore deterministic.
 *   - generated_tasks.building_id is set at schedule-generation time and
 *     acts as the authoritative fallback for task-bound executions across
 *     both engines (per resolveAuthoritativeChecklistSourceContext /
 *     resolveBoundFormInstanceBuilding precedent).
 *   - vendorId is resolved from vendor_checklist_bindings →
 *     vendor_works.vendor_id (CHECKLIST_EXECUTION only). FORM_INSTANCE
 *     has no vendor binding, so vendorId is always NULL there.
 *
 * Multi-row aggregates (itemCount, evidenceCount, findingCount, latest
 * verification review) use scalar subqueries / LATERAL LIMIT 1 so fan-out
 * is impossible. Result responses are intentionally NOT read — only item
 * definitions are counted.
 *
 * DATE WINDOW — applied to `created_at` (the neutral origination timestamp
 * common to both engines) as a half-open [start, end) range, mirroring the
 * finding-register / work-order-register precedent.
 */

type RegisterRow = {
  engine: 'CHECKLIST_EXECUTION' | 'FORM_INSTANCE';
  execution_id: string;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  template_id: string | null;
  template_code: string | null;
  template_name: string | null;
  template_version_id: string | null;
  template_version_number: number | null;
  client_id: string;
  building_id: string;
  asset_id: string | null;
  functional_location_id: string | null;
  vendor_id: string | null;
  item_count: number;
  evidence_count: number;
  finding_count: number;
  verification_review_id: string | null;
  verification_review_status: string | null;
  verification_decision: string | null;
  verification_reviewer_user_id: string | null;
  verification_reviewed_at: Date | null;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapRow(row: RegisterRow): PublicChecklistExecutionSummaryRow {
  return {
    engine: row.engine,
    executionId: row.execution_id,
    status: row.status,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    templateId: row.template_id,
    templateCode: row.template_code,
    templateName: row.template_name,
    templateVersionId: row.template_version_id,
    templateVersionNumber: row.template_version_number,
    clientId: row.client_id,
    buildingId: row.building_id,
    assetId: row.asset_id,
    functionalLocationId: row.functional_location_id,
    vendorId: row.vendor_id,
    itemCount: row.item_count,
    evidenceCount: row.evidence_count,
    findingCount: row.finding_count,
    verificationReviewId: row.verification_review_id,
    verificationReviewStatus: row.verification_review_status,
    verificationDecision: row.verification_decision,
    verificationReviewerUserId: row.verification_reviewer_user_id,
    verificationReviewedAt: toIso(row.verification_reviewed_at),
  };
}

/**
 * Engine-specific building resolution for CHECKLIST_EXECUTION.
 *
 * Each binding column is exclusive in practice; the scalar subquery
 * returns the first non-null binding's building (falling back to
 * generated_tasks). asset_id / functional_location_id come from the
 * engineering binding (the only CE binding that carries them). vendorId
 * comes from vendor_works via vendor_checklist_bindings (vendor-CL flows).
 *
 * Deterministic order:
 *   engineering_checklist_binding → inspection_binding →
 *   toilet_inspection_binding → public_area_inspection_binding →
 *   patrol_checklist_binding → vendor_checklist_binding →
 *   generated_task
 * All paths must have non-null building_id; NULL propagates if no
 * binding matches.
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

const CE_ASSET_SQL = `
  COALESCE(
    (SELECT a FROM (
       SELECT ecb.asset_id AS a FROM engineering_checklist_bindings ecb WHERE ecb.id = ce.engineering_checklist_binding_id
       UNION ALL
       SELECT ib.asset_id FROM inspection_bindings ib WHERE ib.id = ce.inspection_binding_id
     ) _a LIMIT 1),
    NULL
  )
`;

const CE_FUNCTIONAL_LOCATION_SQL = `
  COALESCE(
    (SELECT f FROM (
       SELECT ecb.functional_location_id AS f FROM engineering_checklist_bindings ecb WHERE ecb.id = ce.engineering_checklist_binding_id
       UNION ALL
       SELECT ib.functional_location_id FROM inspection_bindings ib WHERE ib.id = ce.inspection_binding_id
       UNION ALL
       SELECT tib.functional_location_id FROM toilet_inspection_bindings tib WHERE tib.id = ce.toilet_inspection_binding_id
       UNION ALL
       SELECT pa.functional_location_id FROM public_area_inspection_bindings pa WHERE pa.id = ce.public_area_inspection_binding_id
     ) _f LIMIT 1),
    NULL
  )
`;

const CE_VENDOR_SQL = `
  (SELECT vw.vendor_id
     FROM vendor_checklist_bindings vcb
     JOIN vendor_works vw ON vw.id = vcb.vendor_work_id
    WHERE vcb.checklist_execution_id = ce.id
    LIMIT 1)
`;

export async function getChecklistExecutionSummaryRows(
  buildingIds: string[],
  filters: ChecklistExecutionSummaryFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicChecklistExecutionSummaryRow[]> {
  const conds: string[] = ['x.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.engine) {
    values.push(filters.engine);
    conds.push(`x.engine = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conds.push(`x.status = $${values.length}`);
  }
  if (filters.templateId) {
    values.push(filters.templateId);
    conds.push(`x.template_id = $${values.length}`);
  }
  if (filters.assetId) {
    values.push(filters.assetId);
    conds.push(`x.asset_id = $${values.length}`);
  }
  if (filters.functionalLocationId) {
    values.push(filters.functionalLocationId);
    conds.push(`x.functional_location_id = $${values.length}`);
  }
  if (filters.vendorId) {
    values.push(filters.vendorId);
    conds.push(`x.vendor_id = $${values.length}`);
  }
  if (filters.verificationDecision) {
    values.push(filters.verificationDecision);
    conds.push(`vr.decision = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conds.push(`x.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conds.push(`x.created_at < $${values.length}`);
  }

  const result = await getPool().query<RegisterRow>(
    `WITH ce_base AS (
       SELECT ce.id, ce.client_id, ce.checklist_template_id, ce.status,
              ce.started_at, ce.completed_at, ce.created_at, ce.updated_at,
              ce.engineering_checklist_binding_id, ce.inspection_binding_id,
              ce.toilet_inspection_binding_id, ce.public_area_inspection_binding_id,
              ce.patrol_checklist_binding_id, ce.generated_task_id,
              ${CE_BUILDING_SQL} AS building_id,
              ${CE_ASSET_SQL} AS asset_id,
              ${CE_FUNCTIONAL_LOCATION_SQL} AS functional_location_id,
              ${CE_VENDOR_SQL} AS vendor_id
         FROM checklist_executions ce
     ),
     fi_base AS (
       SELECT fi.id, fi.client_id, fi.form_template_version_id, fi.status,
              fi.started_at, fi.completed_at, fi.created_at, fi.updated_at,
              fi.meter_reading_binding_id, fi.log_sheet_binding_id,
              fi.generated_task_id,
              COALESCE(
                (SELECT mrb.building_id FROM meter_reading_bindings mrb
                  WHERE mrb.id = fi.meter_reading_binding_id),
                (SELECT lsb.building_id FROM log_sheet_bindings lsb
                  WHERE lsb.id = fi.log_sheet_binding_id),
                (SELECT gt.building_id FROM generated_tasks gt
                  WHERE gt.id = fi.generated_task_id AND gt.building_id IS NOT NULL),
                NULL
              ) AS building_id,
              COALESCE(
                (SELECT mrb.asset_id FROM meter_reading_bindings mrb
                  WHERE mrb.id = fi.meter_reading_binding_id),
                NULL
              ) AS asset_id,
              COALESCE(
                (SELECT mrb.functional_location_id FROM meter_reading_bindings mrb
                  WHERE mrb.id = fi.meter_reading_binding_id),
                (SELECT lsb.functional_location_id FROM log_sheet_bindings lsb
                  WHERE lsb.id = fi.log_sheet_binding_id),
                NULL
              ) AS functional_location_id,
              NULL::uuid AS vendor_id
         FROM form_instances fi
     ),
     unified AS (
       SELECT 'CHECKLIST_EXECUTION'::text AS engine,
              b.id AS execution_id, b.status, b.started_at, b.completed_at,
              b.created_at, b.updated_at, b.client_id, b.building_id,
              b.asset_id, b.functional_location_id, b.vendor_id,
              ct.id AS template_id, ct.code AS template_code, ct.name AS template_name,
              NULL::uuid AS template_version_id, NULL::int AS template_version_number,
              b.checklist_template_id AS _tpl_ref
         FROM ce_base b
         JOIN checklist_templates ct ON ct.id = b.checklist_template_id
        WHERE b.building_id IS NOT NULL
        UNION ALL
       SELECT 'FORM_INSTANCE'::text AS engine,
              b.id AS execution_id, b.status, b.started_at, b.completed_at,
              b.created_at, b.updated_at, b.client_id, b.building_id,
              b.asset_id, b.functional_location_id, b.vendor_id,
              ft.id AS template_id, ft.code AS template_code, ft.name AS template_name,
              v.id AS template_version_id, v.version_number AS template_version_number,
              b.form_template_version_id AS _tpl_ref
         FROM fi_base b
         JOIN form_template_versions v ON v.id = b.form_template_version_id
         JOIN form_templates ft ON ft.id = v.form_template_id
        WHERE b.building_id IS NOT NULL
     )
     SELECT
       x.engine,
       x.execution_id,
       x.status,
       x.started_at,
       x.completed_at,
       x.created_at,
       x.updated_at,
       x.template_id,
       x.template_code,
       x.template_name,
       x.template_version_id,
       x.template_version_number,
       x.client_id,
       x.building_id,
       x.asset_id,
       x.functional_location_id,
       x.vendor_id,
       COALESCE(ic.item_count, 0)::int AS item_count,
       COALESCE(ev.evidence_count, 0)::int AS evidence_count,
       COALESCE(fn.finding_count, 0)::int AS finding_count,
       vr.id AS verification_review_id,
       vr.status AS verification_review_status,
       vr.decision AS verification_decision,
       vr.reviewer_user_id AS verification_reviewer_user_id,
       vr.reviewed_at AS verification_reviewed_at
     FROM unified x
     LEFT JOIN LATERAL (
       SELECT r.id, r.status, r.decision, r.reviewer_user_id, r.reviewed_at
         FROM reviews r
        WHERE r.target_type = x.engine
          AND r.target_id = x.execution_id
          AND r.status = 'COMPLETED'
        ORDER BY r.reviewed_at DESC, r.created_at DESC, r.id DESC
        LIMIT 1
     ) vr ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS evidence_count
         FROM evidence_submissions es
        WHERE es.execution_type = x.engine
          AND es.execution_id = x.execution_id
          AND es.status = 'ACTIVE'
     ) ev ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS finding_count
         FROM findings f
        WHERE f.source_type = x.engine
          AND f.source_id = x.execution_id
     ) fn ON TRUE
     LEFT JOIN LATERAL (
       SELECT
         CASE x.engine
           WHEN 'CHECKLIST_EXECUTION' THEN
             (SELECT count(*)::int FROM checklist_items ci
               WHERE ci.checklist_template_id = x._tpl_ref)
           WHEN 'FORM_INSTANCE' THEN
             (SELECT count(*)::int FROM form_template_version_fields fvf
               WHERE fvf.version_section_id IN (
                 SELECT id FROM form_template_version_sections
                  WHERE version_id = x._tpl_ref
               ))
         END AS item_count
     ) ic ON TRUE
     WHERE ${conds.join(' AND ')}
     ORDER BY x.created_at DESC, x.execution_id ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

export const checklistExecutionSummaryRepository = {
  getChecklistExecutionSummaryRows,
};

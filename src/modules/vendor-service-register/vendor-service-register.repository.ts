import { getPool } from '../../database';
import type {
  PublicVendorServiceRegisterRow,
  VendorServiceRegisterFilters,
} from './vendor-service-register.types';

/**
 * CR-BE-REPORT-READ-01 PART 01 — Vendor Service Register repository.
 *
 * One read-only statement over the existing authoritative records. Grain is
 * exactly one row per `vendor_works` row: mandatory links are INNER-joined
 * (mirroring the BE-23H vendor source), optional singleton links are
 * LEFT-joined (uniqueness per vendor work is schema-enforced by migrations
 * 0160/0161/0162, so no fan-out is possible), and multi-row links use
 * LEFT JOIN LATERAL with the authorities' own selection semantics:
 *
 * LATEST VERIFICATION — `reviews` with target_type = 'VENDOR_WORK',
 * ORDER BY created_at DESC, id LIMIT 1. The DESC direction mirrors
 * `listReviewsByVendorWork` (ORDER BY created_at ASC, service takes the
 * last element as "the most recently reviewed row"); the `, id` tiebreak
 * mirrors the shared BE-07 reviews engine
 * (`ORDER BY created_at DESC, id` in review.service.ts). No new rule.
 *
 * LATEST REWORK — `vendor_rework_cycles` ORDER BY requested_at DESC,
 * id DESC LIMIT 1: the exact inverse of the authoritative cycle listing
 * (`ORDER BY requested_at, id` in listByVendorWorkId). Count is a direct
 * COUNT(*) over persisted cycles. No new rule.
 *
 * CHECKLIST — COUNT(*) only. Bindings are unique per (vendor work,
 * template) for ACTIVE rows, so no authoritative singleton exists and no
 * binding/execution identity is selected.
 *
 * CANONICAL BAST — scope-constrained LEFT JOIN (`bd.id = vb.bast_document_id
 * AND bd.client_id = vb.client_id AND bd.building_id = vb.building_id`)
 * mirroring the BAST compatibility projection's join; both stored statuses
 * are returned verbatim without resolution.
 *
 * DATE WINDOW — applied to `vendor_assignments.assigned_at` as a half-open
 * [start, end) range, mirroring the BE-23H vendor scope convention.
 *
 * No writes, no ETL, no new tables. `vendor_works.building_id` (derived
 * authoritatively by BE-15B from the Work Order) is the isolation column,
 * exactly as in BE-23H.
 */

type RegisterRow = {
  vendor_work_id: string;
  vendor_assignment_id: string;
  assigned_at: Date;
  vendor_id: string;
  vendor_code: string;
  vendor_name: string;
  work_order_id: string;
  work_order_number: string;
  work_order_status: string;
  functional_location_id: string | null;
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  vendor_work_status: string;
  vendor_work_started_at: Date | null;
  vendor_work_completed_at: Date | null;
  checklist_binding_count: number;
  completion_report_id: string | null;
  completion_report_status: string | null;
  completion_submitted_at: Date | null;
  service_report_id: string | null;
  service_report_number: string | null;
  service_report_status: string | null;
  service_report_date: string | null;
  service_report_finalized_at: Date | null;
  verification_review_id: string | null;
  verification_decision: string | null;
  verification_reviewed_at: Date | null;
  rework_count: number;
  latest_rework_id: string | null;
  latest_rework_status: string | null;
  bast_binding_id: string | null;
  bast_number: string | null;
  bast_date: string | null;
  bast_acceptance_status: string | null;
  bast_submitted_at: Date | null;
  bast_accepted_at: Date | null;
  canonical_bast_document_id: string | null;
  canonical_bast_acceptance_status: string | null;
  building_id: string;
  client_id: string;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapRow(row: RegisterRow): PublicVendorServiceRegisterRow {
  return {
    vendorWorkId: row.vendor_work_id,
    vendorAssignmentId: row.vendor_assignment_id,
    assignedAt: row.assigned_at.toISOString(),
    vendorId: row.vendor_id,
    vendorCode: row.vendor_code,
    vendorName: row.vendor_name,
    workOrderId: row.work_order_id,
    workOrderNumber: row.work_order_number,
    workOrderStatus: row.work_order_status,
    functionalLocationId: row.functional_location_id,
    assetId: row.asset_id,
    assetCode: row.asset_code,
    assetName: row.asset_name,
    vendorWorkStatus: row.vendor_work_status,
    vendorWorkStartedAt: toIso(row.vendor_work_started_at),
    vendorWorkCompletedAt: toIso(row.vendor_work_completed_at),
    checklistBindingCount: row.checklist_binding_count,
    completionReportId: row.completion_report_id,
    completionReportStatus: row.completion_report_status,
    completionSubmittedAt: toIso(row.completion_submitted_at),
    serviceReportId: row.service_report_id,
    serviceReportNumber: row.service_report_number,
    serviceReportStatus: row.service_report_status,
    serviceReportDate: row.service_report_date,
    serviceReportFinalizedAt: toIso(row.service_report_finalized_at),
    verificationReviewId: row.verification_review_id,
    verificationDecision: row.verification_decision,
    verificationReviewedAt: toIso(row.verification_reviewed_at),
    reworkCount: row.rework_count,
    latestReworkId: row.latest_rework_id,
    latestReworkStatus: row.latest_rework_status,
    bastBindingId: row.bast_binding_id,
    bastNumber: row.bast_number,
    bastDate: row.bast_date,
    bastAcceptanceStatus: row.bast_acceptance_status,
    bastSubmittedAt: toIso(row.bast_submitted_at),
    bastAcceptedAt: toIso(row.bast_accepted_at),
    canonicalBastDocumentId: row.canonical_bast_document_id,
    canonicalBastAcceptanceStatus: row.canonical_bast_acceptance_status,
    buildingId: row.building_id,
    clientId: row.client_id,
  };
}

export async function getVendorServiceRegisterRows(
  buildingIds: string[],
  filters: VendorServiceRegisterFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicVendorServiceRegisterRow[]> {
  const conditions: string[] = ['vw.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.vendorId) {
    values.push(filters.vendorId);
    conditions.push(`vw.vendor_id = $${values.length}`);
  }
  if (filters.workOrderId) {
    values.push(filters.workOrderId);
    conditions.push(`vw.work_order_id = $${values.length}`);
  }
  if (filters.assetId) {
    values.push(filters.assetId);
    conditions.push(`wo.asset_id = $${values.length}`);
  }
  if (filters.vendorWorkStatus) {
    values.push(filters.vendorWorkStatus);
    conditions.push(`vw.status = $${values.length}`);
  }
  if (filters.verificationDecision) {
    values.push(filters.verificationDecision);
    conditions.push(`vr.decision = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`va.assigned_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`va.assigned_at < $${values.length}`);
  }

  const result = await getPool().query<RegisterRow>(
    `SELECT
       vw.id AS vendor_work_id,
       va.id AS vendor_assignment_id,
       va.assigned_at AS assigned_at,
       v.id AS vendor_id,
       v.vendor_code AS vendor_code,
       v.vendor_name AS vendor_name,
       wo.id AS work_order_id,
       wo.work_order_number AS work_order_number,
       wo.status AS work_order_status,
       wo.functional_location_id AS functional_location_id,
       a.id AS asset_id,
       a.asset_code AS asset_code,
       a.asset_name AS asset_name,
       vw.status AS vendor_work_status,
       vw.started_at AS vendor_work_started_at,
       vw.completed_at AS vendor_work_completed_at,
       cb.checklist_binding_count AS checklist_binding_count,
       vcr.id AS completion_report_id,
       vcr.completion_status AS completion_report_status,
       vcr.completed_at AS completion_submitted_at,
       vsr.id AS service_report_id,
       vsr.service_report_number AS service_report_number,
       vsr.status AS service_report_status,
       vsr.service_date::text AS service_report_date,
       vsr.finalized_at AS service_report_finalized_at,
       vr.id AS verification_review_id,
       vr.decision AS verification_decision,
       vr.reviewed_at AS verification_reviewed_at,
       rw.rework_count AS rework_count,
       rw.latest_rework_id AS latest_rework_id,
       rw.latest_rework_status AS latest_rework_status,
       vb.id AS bast_binding_id,
       vb.bast_number AS bast_number,
       vb.bast_date::text AS bast_date,
       vb.acceptance_status AS bast_acceptance_status,
       vb.submitted_at AS bast_submitted_at,
       vb.accepted_at AS bast_accepted_at,
       bd.id AS canonical_bast_document_id,
       bd.acceptance_status AS canonical_bast_acceptance_status,
       vw.building_id AS building_id,
       v.client_id AS client_id
     FROM vendor_works vw
     JOIN vendor_assignments va ON va.id = vw.vendor_assignment_id
     JOIN vendors v ON v.id = vw.vendor_id
     LEFT JOIN work_orders wo
       ON wo.id = vw.work_order_id
      AND wo.client_id = v.client_id
      AND wo.building_id = vw.building_id
     LEFT JOIN assets a ON a.id = wo.asset_id
     LEFT JOIN vendor_completion_reports vcr ON vcr.vendor_work_id = vw.id
     LEFT JOIN vendor_service_reports vsr ON vsr.vendor_work_id = vw.id
     LEFT JOIN LATERAL (
       SELECT r.id, r.decision, r.reviewed_at
       FROM reviews r
       WHERE r.target_type = 'VENDOR_WORK' AND r.target_id = vw.id
       ORDER BY r.created_at DESC, r.id
       LIMIT 1
     ) vr ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS rework_count,
         (SELECT c.id FROM vendor_rework_cycles c
           WHERE c.vendor_work_id = vw.id
           ORDER BY c.requested_at DESC, c.id DESC LIMIT 1) AS latest_rework_id,
         (SELECT c.status FROM vendor_rework_cycles c
           WHERE c.vendor_work_id = vw.id
           ORDER BY c.requested_at DESC, c.id DESC LIMIT 1) AS latest_rework_status
     ) rw ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS checklist_binding_count
       FROM vendor_checklist_bindings vcb
       WHERE vcb.vendor_work_id = vw.id
     ) cb ON TRUE
     LEFT JOIN vendor_bast_bindings vb ON vb.vendor_work_id = vw.id
     LEFT JOIN bast_documents bd
       ON bd.id = vb.bast_document_id
      AND bd.client_id = vb.client_id
      AND bd.building_id = vb.building_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY vw.created_at ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

export const vendorServiceRegisterRepository = {
  getVendorServiceRegisterRows,
};

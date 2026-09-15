import { getPool } from '../../database';
import type {
  PublicWorkOrderRegisterRow,
  WorkOrderRegisterFilters,
} from './work-order-register.types';

/**
 * CR-BE-REPORT-READ-03 PART 01 — Work Order Register repository.
 *
 * One read-only statement over the existing authoritative records. Grain is
 * exactly one row per `work_orders` row: mandatory filters are applied
 * directly to `work_orders`; optional singleton links are LEFT-joined
 * (uniqueness per work order is schema-enforced — the BE-08E partial unique
 * index over ACTIVE `work_order_assignments` rows guarantees at most one
 * active assignment, and asset/functional_location are 0..1 direct FKs — so
 * no fan-out is possible); multi-row links use LEFT JOIN LATERAL with the
 * authorities' own selection semantics:
 *
 * ACTIVE ASSIGNMENT — `work_order_assignments WHERE status='ACTIVE'`
 * (LIMIT 1 defensively; schema guarantees ≤1 row). The optional
 * `assignedUserId` filter resolves through `workforce_profiles.user_id`
 * (the 1:1 binding used by BE-03C); `assignedTeamId` and `vendorId`
 * filter directly on the ACTIVE assignment. Vendor/VENDOR_WORKFORCE
 * assignees both carry vendor_id.
 *
 * LATEST VERIFICATION — `reviews` with target_type='WORK_ORDER' AND
 * status='COMPLETED', ORDER BY reviewed_at DESC, created_at DESC, id DESC
 * LIMIT 1. Reuses `workOrderVerificationRepository.findLatestCompletedReview`
 * ordering (the neutral latest-COMPLETED selector; not latest-APPROVED,
 * which is closure-gating logic owned by the lifecycle service).
 *
 * EVIDENCE — direct COUNT(*) over `evidence_submissions WHERE
 * execution_type='WORK_ORDER' AND execution_id = wo.id AND status='ACTIVE'`,
 * mirroring `work-order-evidence` list-mode semantics. Only the count.
 *
 * FINDINGS — direct COUNT(*) over `findings WHERE source_type='WORK_ORDER'
 * AND source_id = wo.id`. total only; openFindingCount is deliberately
 * absent because no single cross-domain "open" status set exists.
 *
 * HISTORY — direct COUNT(*) over `operational_events WHERE
 * entity_type='WORK_ORDER' AND entity_id = wo.id` (the table used by
 * work-order-history). `historyAvailable = historyCount > 0`.
 *
 * ASSET / FUNCTIONAL LOCATION labels are LEFT-joined directly from the
 * owning authorities' tables to expose code/name; floor/area/room
 * traversal is explicitly deferred (requires OperationalContext
 * resolution beyond a bounded register read).
 *
 * DATE WINDOW — applied to `wo.created_at` as a half-open [start, end)
 * range, mirroring the BE-23H reporting convention and the
 * management-work-order-summary KPI range.
 *
 * No writes, no ETL, no new tables. `work_orders.building_id` is the
 * isolation column, exactly as in the sibling vendor-service-register and
 * finding-register read models.
 */

type RegisterRow = {
  work_order_id: string;
  work_order_number: string;
  title: string;
  description: string | null;
  status: string;
  client_id: string;
  building_id: string;
  asset_id: string | null;
  asset_code: string | null;
  asset_name: string | null;
  functional_location_id: string | null;
  functional_location_code: string | null;
  functional_location_name: string | null;
  work_type: string;
  priority: string;
  bast_requirement: string;
  work_request_id: string | null;
  created_at: Date;
  assigned_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
  assignee_type: string | null;
  assigned_workforce_profile_id: string | null;
  assigned_team_id: string | null;
  assigned_vendor_id: string | null;
  assigned_by_user_id: string | null;
  assignment_assigned_at: Date | null;
  evidence_count: number;
  finding_count: number;
  verification_review_id: string | null;
  verification_review_status: string | null;
  verification_decision: string | null;
  verification_reviewer_user_id: string | null;
  verification_reviewed_at: Date | null;
  completed_by_user_id: string | null;
  completion_summary: string | null;
  completion_notes: string | null;
  history_count: number;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapRow(row: RegisterRow): PublicWorkOrderRegisterRow {
  return {
    workOrderId: row.work_order_id,
    workOrderNumber: row.work_order_number,
    title: row.title,
    description: row.description,
    status: row.status,
    clientId: row.client_id,
    buildingId: row.building_id,
    assetId: row.asset_id,
    assetCode: row.asset_code,
    assetName: row.asset_name,
    functionalLocationId: row.functional_location_id,
    functionalLocationCode: row.functional_location_code,
    functionalLocationName: row.functional_location_name,
    workType: row.work_type,
    priority: row.priority,
    bastRequirement: row.bast_requirement,
    workRequestId: row.work_request_id,
    createdAt: row.created_at.toISOString(),
    assignedAt: toIso(row.assigned_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    closedAt: toIso(row.closed_at),
    cancelledAt: toIso(row.cancelled_at),
    assigneeType: row.assignee_type,
    assignedWorkforceProfileId: row.assigned_workforce_profile_id,
    assignedTeamId: row.assigned_team_id,
    assignedVendorId: row.assigned_vendor_id,
    assignedByUserId: row.assigned_by_user_id,
    assignmentAssignedAt: toIso(row.assignment_assigned_at),
    evidenceCount: row.evidence_count,
    findingCount: row.finding_count,
    verificationReviewId: row.verification_review_id,
    verificationReviewStatus: row.verification_review_status,
    verificationDecision: row.verification_decision,
    verificationReviewerUserId: row.verification_reviewer_user_id,
    verificationReviewedAt: toIso(row.verification_reviewed_at),
    completedByUserId: row.completed_by_user_id,
    completionSummary: row.completion_summary,
    completionNotes: row.completion_notes,
    historyAvailable: row.history_count > 0,
    historyCount: row.history_count,
  };
}

export async function getWorkOrderRegisterRows(
  buildingIds: string[],
  filters: WorkOrderRegisterFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicWorkOrderRegisterRow[]> {
  const conditions: string[] = ['wo.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.status) {
    values.push(filters.status);
    conditions.push(`wo.status = $${values.length}`);
  }
  if (filters.workType) {
    values.push(filters.workType);
    conditions.push(`wo.work_type = $${values.length}`);
  }
  if (filters.priority) {
    values.push(filters.priority);
    conditions.push(`wo.priority = $${values.length}`);
  }
  if (filters.bastRequirement) {
    values.push(filters.bastRequirement);
    conditions.push(`wo.bast_requirement = $${values.length}`);
  }
  if (filters.assetId) {
    values.push(filters.assetId);
    conditions.push(`wo.asset_id = $${values.length}`);
  }
  if (filters.assignedUserId) {
    // Narrowing WORKFORCE assignees through the 1:1 workforce_profiles.user_id
    // binding (same pattern as finding-register). Non-WORKFORCE assignments
    // are excluded when this filter is supplied, matching the data shape.
    values.push(filters.assignedUserId);
    conditions.push(`fa.assignee_type = 'WORKFORCE'`);
    conditions.push(`wp.user_id = $${values.length}`);
  }
  if (filters.assignedTeamId) {
    values.push(filters.assignedTeamId);
    conditions.push(`fa.assignee_type = 'TEAM'`);
    conditions.push(`fa.team_id = $${values.length}`);
  }
  if (filters.vendorId) {
    values.push(filters.vendorId);
    conditions.push(`fa.assignee_type IN ('VENDOR','VENDOR_WORKFORCE')`);
    conditions.push(`fa.vendor_id = $${values.length}`);
  }
  if (filters.verificationDecision) {
    values.push(filters.verificationDecision);
    conditions.push(`vr.decision = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`wo.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`wo.created_at < $${values.length}`);
  }

  const result = await getPool().query<RegisterRow>(
    `SELECT
       wo.id AS work_order_id,
       wo.work_order_number AS work_order_number,
       wo.title,
       wo.description,
       wo.status,
       wo.client_id,
       wo.building_id AS building_id,
       wo.asset_id AS asset_id,
       a.asset_code AS asset_code,
       a.asset_name AS asset_name,
       wo.functional_location_id AS functional_location_id,
       fl.code AS functional_location_code,
       fl.name AS functional_location_name,
       wo.work_type AS work_type,
       wo.priority,
       wo.bast_requirement AS bast_requirement,
       wo.work_request_id AS work_request_id,
       wo.created_at AS created_at,
       wo.assigned_at AS assigned_at,
       wo.started_at AS started_at,
       wo.completed_at AS completed_at,
       wo.closed_at AS closed_at,
       wo.cancelled_at AS cancelled_at,
       fa.assignee_type AS assignee_type,
       fa.workforce_profile_id AS assigned_workforce_profile_id,
       fa.team_id AS assigned_team_id,
       fa.vendor_id AS assigned_vendor_id,
       fa.assigned_by_user_id AS assigned_by_user_id,
       fa.assigned_at AS assignment_assigned_at,
       COALESCE(ev.evidence_count, 0)::int AS evidence_count,
       COALESCE(fn.finding_count, 0)::int AS finding_count,
       vr.id AS verification_review_id,
       vr.status AS verification_review_status,
       vr.decision AS verification_decision,
       vr.reviewer_user_id AS verification_reviewer_user_id,
       vr.reviewed_at AS verification_reviewed_at,
       wo.completed_by_user_id AS completed_by_user_id,
       wo.completion_summary AS completion_summary,
       wo.completion_notes AS completion_notes,
       COALESCE(h.history_count, 0)::int AS history_count
     FROM work_orders wo
     LEFT JOIN assets a
       ON a.id = wo.asset_id
     LEFT JOIN functional_locations fl
       ON fl.id = wo.functional_location_id
     LEFT JOIN work_order_assignments fa
       ON fa.work_order_id = wo.id AND fa.status = 'ACTIVE'
     LEFT JOIN workforce_profiles wp
       ON wp.id = fa.workforce_profile_id AND fa.assignee_type = 'WORKFORCE'
     LEFT JOIN LATERAL (
       SELECT r.id, r.status, r.decision,
              r.reviewer_user_id, r.reviewed_at
       FROM reviews r
       WHERE r.target_type = 'WORK_ORDER' AND r.target_id = wo.id
         AND r.status = 'COMPLETED'
       ORDER BY r.reviewed_at DESC, r.created_at DESC, r.id DESC
       LIMIT 1
     ) vr ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS evidence_count
       FROM evidence_submissions es
       WHERE es.execution_type = 'WORK_ORDER'
         AND es.execution_id = wo.id
         AND es.status = 'ACTIVE'
     ) ev ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS finding_count
       FROM findings f
       WHERE f.source_type = 'WORK_ORDER'
         AND f.source_id = wo.id
         AND f.client_id = wo.client_id
         AND f.building_id = wo.building_id
     ) fn ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS history_count
       FROM operational_events oe
       WHERE oe.entity_type = 'WORK_ORDER'
         AND oe.entity_id = wo.id
     ) h ON TRUE
     WHERE ${conditions.join(' AND ')}
     ORDER BY wo.created_at DESC, wo.id ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

export const workOrderRegisterRepository = {
  getWorkOrderRegisterRows,
};

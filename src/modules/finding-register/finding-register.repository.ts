import { getPool } from '../../database';
import type {
  PublicFindingRegisterRow,
  FindingRegisterFilters,
} from './finding-register.types';

/**
 * CR-BE-REPORT-READ-02 PART 01 — Finding Register repository.
 *
 * One read-only statement over the existing authoritative records. Grain is
 * exactly one row per `findings` row: mandatory filters are applied directly
 * to `findings`; optional singleton links are LEFT-joined (uniqueness per
 * finding is schema-enforced, so no fan-out is possible); multi-row links
 * use LEFT JOIN LATERAL with the authorities' own selection semantics:
 *
 * ACTIVE ASSIGNMENT — `finding_assignments WHERE status='ACTIVE' LIMIT 1`,
 * mirroring the exact LEFT JOIN used by management-critical-findings and
 * `findingAssignmentRepository.findActiveByFindingId`. The optional
 * `assignedUserId` filter resolves through `workforce_profiles.user_id`
 * (the 1:1 binding used by the finding-assignments validation authority);
 * non-WORKFORCE assignments are not filtered by userId.
 *
 * LATEST REVIEW — `reviews` with target_type='FINDING', ORDER BY
 * created_at DESC, id LIMIT 1. This reuses the ordering of
 * `findingReviewRepository.findPendingByFindingId` (the "pending-current"
 * selector). Returning the most recent row regardless of its status lets
 * Reporting read both PENDING in-flight reviews and COMPLETED verifications
 * without reinterpreting the state machine.
 *
 * LATEST REWORK — the most recent cycle by the authority's list ordering
 * (requested_at DESC, id DESC — the inverse of `listByFindingId`'s
 * `ORDER BY requested_at, id`), mirroring the pattern used by
 * vendor-service-register. This surfaces the current REQUESTED cycle
 * when one exists and otherwise the most recent completed cycle, without
 * reinterpreting state. `reworkCount` is a direct COUNT(*) over all
 * persisted cycles regardless of status.
 *
 * EVIDENCE — direct COUNT(*) over `evidence_submissions WHERE
 * execution_type='FINDING' AND execution_id = f.id AND status='ACTIVE'`,
 * mirroring the listing semantics of `findingEvidence` mode='list'
 * (status='ACTIVE', ordered by created_at,id). Only the count is exposed.
 *
 * HISTORY — direct COUNT(*) over `operational_events WHERE
 * entity_type='FINDING' AND entity_id = f.id` (the table used by
 * finding-history). `historyAvailable = historyCount > 0`. No detail
 * rows are materialized.
 *
 * SOURCE ENRICHMENT — work_orders is LEFT-joined ONLY when
 * `f.source_type = 'WORK_ORDER'` (a bounded, schema-bound join) to
 * surface `sourceReferenceNumber = work_order_number`, plus assetId and
 * functionalLocationId when present. FORM_INSTANCE / CHECKLIST_EXECUTION
 * source types expose sourceType+sourceId only — no universal source
 * engine is introduced. The optional `sourceId` filter narrows on
 * `f.source_id` by exact match, independently of `sourceType`, and adds
 * no join and no source resolution.
 *
 * CLASSIFICATION / SEVERITY labels are LEFT-joined from the respective
 * authorities' tables to expose code/name(/rank) verbatim; nulls are
 * preserved when the Finding has no classification/severity bound or
 * the referenced row is missing.
 *
 * DATE WINDOW — applied to `f.reported_at` as a half-open [start, end)
 * range, mirroring BE-23H reporting convention.
 *
 * No writes, no ETL, no new tables. `findings.building_id` is the
 * isolation column, exactly as in BE-23H / BE-23I / vendor-service-register.
 */

type RegisterRow = {
  finding_id: string;
  finding_number: string;
  title: string;
  description: string | null;
  status: string;
  classification_id: string | null;
  classification_code: string | null;
  classification_name: string | null;
  severity_id: string | null;
  severity_code: string | null;
  severity_name: string | null;
  severity_rank: number | null;
  source_type: string | null;
  source_id: string | null;
  source_reference_number: string | null;
  client_id: string;
  building_id: string;
  asset_id: string | null;
  functional_location_id: string | null;
  reported_by_user_id: string;
  reported_at: Date;
  created_at: Date;
  state_changed_at: Date;
  assignee_type: string | null;
  assigned_workforce_profile_id: string | null;
  assigned_team_id: string | null;
  assigned_vendor_id: string | null;
  assigned_by_user_id: string | null;
  assigned_at: Date | null;
  evidence_count: number;
  rework_count: number;
  latest_rework_id: string | null;
  latest_rework_status: string | null;
  latest_rework_requested_at: Date | null;
  verification_review_id: string | null;
  verification_review_status: string | null;
  verification_decision: string | null;
  verification_reviewer_user_id: string | null;
  verification_reviewed_at: Date | null;
  closed_at: Date | null;
  closed_by_user_id: string | null;
  closure_notes: string | null;
  history_count: number;
};

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapRow(row: RegisterRow): PublicFindingRegisterRow {
  return {
    findingId: row.finding_id,
    findingNumber: row.finding_number,
    title: row.title,
    description: row.description,
    status: row.status,
    classificationId: row.classification_id,
    classificationCode: row.classification_code,
    classificationName: row.classification_name,
    severityId: row.severity_id,
    severityCode: row.severity_code,
    severityName: row.severity_name,
    severityRank: row.severity_rank,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceReferenceNumber: row.source_reference_number,
    clientId: row.client_id,
    buildingId: row.building_id,
    assetId: row.asset_id,
    functionalLocationId: row.functional_location_id,
    reportedByUserId: row.reported_by_user_id,
    reportedAt: row.reported_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    stateChangedAt: row.state_changed_at.toISOString(),
    assigneeType: row.assignee_type,
    assignedWorkforceProfileId: row.assigned_workforce_profile_id,
    assignedTeamId: row.assigned_team_id,
    assignedVendorId: row.assigned_vendor_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: toIso(row.assigned_at),
    evidenceCount: row.evidence_count,
    reworkCount: row.rework_count,
    latestReworkId: row.latest_rework_id,
    latestReworkStatus: row.latest_rework_status,
    latestReworkRequestedAt: toIso(row.latest_rework_requested_at),
    verificationReviewId: row.verification_review_id,
    verificationReviewStatus: row.verification_review_status,
    verificationDecision: row.verification_decision,
    verificationReviewerUserId: row.verification_reviewer_user_id,
    verificationReviewedAt: toIso(row.verification_reviewed_at),
    closedAt: toIso(row.closed_at),
    closedByUserId: row.closed_by_user_id,
    closureNotes: row.closure_notes,
    historyAvailable: row.history_count > 0,
    historyCount: row.history_count,
  };
}

export async function getFindingRegisterRows(
  buildingIds: string[],
  filters: FindingRegisterFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicFindingRegisterRow[]> {
  const conditions: string[] = ['f.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.status) {
    values.push(filters.status);
    conditions.push(`f.status = $${values.length}`);
  }
  if (filters.classificationId) {
    values.push(filters.classificationId);
    conditions.push(`f.classification_id = $${values.length}`);
  }
  if (filters.severityId) {
    values.push(filters.severityId);
    conditions.push(`f.severity_id = $${values.length}`);
  }
  if (filters.sourceType) {
    values.push(filters.sourceType);
    conditions.push(`f.source_type = $${values.length}`);
  }
  if (filters.sourceId) {
    // Exact-match narrowing on the persisted source binding. INDEPENDENT of
    // `sourceType`: the two are conjunctive when both are supplied and
    // neither is inferred from the other. No polymorphic source traversal —
    // the referenced source record is never joined, resolved, or
    // dereferenced here. The unconditional authorized-building predicate
    // `f.building_id = ANY($1::uuid[])` seeded above is never replaced,
    // weakened, or bypassed by this condition.
    values.push(filters.sourceId);
    conditions.push(`f.source_id = $${values.length}`);
  }
  if (filters.assignedUserId) {
    // Assigned-user narrowing uses the ACTIVE workforce assignment binding
    // through the workforce_profiles.user_id FK. Non-WORKFORCE assignments
    // are excluded when this filter is supplied, because they have no
    // workforce user binding — this matches the authority's own data shape.
    values.push(filters.assignedUserId);
    conditions.push(`fa.assignee_type = 'WORKFORCE'`);
    conditions.push(`wp.user_id = $${values.length}`);
  }
  if (filters.verificationDecision) {
    values.push(filters.verificationDecision);
    conditions.push(`vr.decision = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`f.reported_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`f.reported_at < $${values.length}`);
  }

  const result = await getPool().query<RegisterRow>(
    `SELECT
       f.id AS finding_id,
       f.finding_number AS finding_number,
       f.title,
       f.description,
       f.status,
       f.classification_id AS classification_id,
       fc.code AS classification_code,
       fc.name AS classification_name,
       f.severity_id AS severity_id,
       fs.code AS severity_code,
       fs.name AS severity_name,
       fs.rank AS severity_rank,
       f.source_type AS source_type,
       f.source_id AS source_id,
       wo.work_order_number AS source_reference_number,
       f.client_id,
       f.building_id AS building_id,
       wo.asset_id AS asset_id,
       wo.functional_location_id AS functional_location_id,
       f.reported_by_user_id AS reported_by_user_id,
       f.reported_at AS reported_at,
       f.created_at AS created_at,
       f.state_changed_at AS state_changed_at,
       fa.assignee_type AS assignee_type,
       fa.workforce_profile_id AS assigned_workforce_profile_id,
       fa.team_id AS assigned_team_id,
       fa.vendor_id AS assigned_vendor_id,
       fa.assigned_by_user_id AS assigned_by_user_id,
       fa.assigned_at AS assigned_at,
       COALESCE(ev.evidence_count, 0)::int AS evidence_count,
       COALESCE(rw.rework_count, 0)::int AS rework_count,
       rw.latest_rework_id AS latest_rework_id,
       rw.latest_rework_status AS latest_rework_status,
       rw.latest_rework_requested_at AS latest_rework_requested_at,
       vr.id AS verification_review_id,
       vr.status AS verification_review_status,
       vr.decision AS verification_decision,
       vr.reviewer_user_id AS verification_reviewer_user_id,
       vr.reviewed_at AS verification_reviewed_at,
       f.closed_at AS closed_at,
       f.closed_by_user_id AS closed_by_user_id,
       f.closure_notes AS closure_notes,
       COALESCE(h.history_count, 0)::int AS history_count
     FROM findings f
     LEFT JOIN finding_classifications fc
       ON fc.id = f.classification_id
     LEFT JOIN finding_severities fs
       ON fs.id = f.severity_id
     LEFT JOIN finding_assignments fa
       ON fa.finding_id = f.id AND fa.status = 'ACTIVE'
     LEFT JOIN workforce_profiles wp
       ON wp.id = fa.workforce_profile_id AND fa.assignee_type = 'WORKFORCE'
     LEFT JOIN work_orders wo
       ON wo.id = f.source_id
      AND f.source_type = 'WORK_ORDER'
      AND wo.client_id = f.client_id
      AND wo.building_id = f.building_id
     LEFT JOIN LATERAL (
       SELECT r.id, r.status, r.decision,
              r.reviewer_user_id, r.reviewed_at
       FROM reviews r
       WHERE r.target_type = 'FINDING' AND r.target_id = f.id
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT 1
     ) vr ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS rework_count,
         (SELECT c.id FROM finding_rework_cycles c
           WHERE c.finding_id = f.id
           ORDER BY c.requested_at DESC, c.id DESC LIMIT 1) AS latest_rework_id,
         (SELECT c.status FROM finding_rework_cycles c
           WHERE c.finding_id = f.id
           ORDER BY c.requested_at DESC, c.id DESC LIMIT 1) AS latest_rework_status,
         (SELECT c.requested_at FROM finding_rework_cycles c
           WHERE c.finding_id = f.id
           ORDER BY c.requested_at DESC, c.id DESC LIMIT 1) AS latest_rework_requested_at
     ) rw ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS evidence_count
       FROM evidence_submissions es
       WHERE es.execution_type = 'FINDING'
         AND es.execution_id = f.id
         AND es.status = 'ACTIVE'
     ) ev ON TRUE
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS history_count
       FROM operational_events oe
       WHERE oe.entity_type = 'FINDING'
         AND oe.entity_id = f.id
     ) h ON TRUE
     WHERE ${conditions.join(' AND ')}
     ORDER BY f.reported_at DESC, f.created_at DESC, f.id ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

export const findingRegisterRepository = {
  getFindingRegisterRows,
};

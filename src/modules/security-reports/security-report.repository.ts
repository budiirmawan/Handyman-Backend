import { getPool } from '../../database';
import type {
  PublicIncidentReadinessDatasetRow,
  PublicKeyControlDatasetRow,
  PublicLostFoundDatasetRow,
  PublicPatrolDatasetRow,
  PublicSecurityFindingDatasetRow,
  PublicSecurityPostDatasetRow,
  PublicSecuritySummary,
  PublicShiftHandoverDatasetRow,
  PublicVisitorBindingDatasetRow,
  SecurityReportFilters,
} from './security-report.types';
import { reportRange } from './security-report.validation';

/**
 * BE-12M — Security Reporting Dataset repository.
 *
 * Direct read queries over the authoritative BE-12 operational
 * records. Every dataset is a single SQL statement (no N+1, no ETL,
 * no duplicated operational tables). Counts always come from the
 * source tables themselves.
 *
 * All queries are scoped to a `buildingIds` array (one Building for
 * per-Building calls, the full accessible set for the summary
 * rollup). The service is responsible for resolving the scope and
 * asserting access before calling these functions.
 */

export type SecuritySummaryRow = {
  posts_total: number;
  posts_active: number;
  posts_inactive: number;
  routes_total: number;
  routes_active: number;
  routes_inactive: number;
  patrols_scheduled: number;
  patrols_in_progress: number;
  patrols_completed: number;
  patrols_cancelled: number;
  checklists_open: number;
  checklists_completed: number;
  findings_open: number;
  findings_verified: number;
  findings_closed: number;
  shift_handovers_active: number;
  shift_handovers_draft: number;
  shift_handovers_ready: number;
  shift_handovers_acknowledged: number;
  incident_readiness_not_ready: number;
  incident_readiness_partial: number;
  incident_readiness_ready: number;
  incident_readiness_active: number;
  visitor_bindings_active: number;
  visitor_bindings_inactive: number;
  keys_available: number;
  keys_issued: number;
  keys_overdue: number;
  keys_lost: number;
  keys_inactive: number;
  keys_open_custody: number;
  lost_found_found: number;
  lost_found_in_custody: number;
  lost_found_claimed: number;
  lost_found_returned: number;
  lost_found_disposed: number;
  lost_found_closed: number;
};

const ANY_BUILDING_IDS_FRAGMENT = `= ANY($1::uuid[])`;

export async function getSecuritySummary(
  buildingIds: string[],
  start: Date | null,
  end: Date | null,
): Promise<SecuritySummaryRow> {
  const result = await getPool().query<SecuritySummaryRow>(
    `SELECT
       (SELECT count(*)::int FROM security_posts sp
         WHERE sp.building_id ${ANY_BUILDING_IDS_FRAGMENT})
         AS posts_total,
       (SELECT count(*)::int FROM security_posts sp
         WHERE sp.building_id ${ANY_BUILDING_IDS_FRAGMENT} AND sp.status = 'ACTIVE')
         AS posts_active,
       (SELECT count(*)::int FROM security_posts sp
         WHERE sp.building_id ${ANY_BUILDING_IDS_FRAGMENT} AND sp.status = 'INACTIVE')
         AS posts_inactive,
       (SELECT count(*)::int FROM patrol_routes pr
         WHERE pr.building_id ${ANY_BUILDING_IDS_FRAGMENT})
         AS routes_total,
       (SELECT count(*)::int FROM patrol_routes pr
         WHERE pr.building_id ${ANY_BUILDING_IDS_FRAGMENT} AND pr.status = 'ACTIVE')
         AS routes_active,
       (SELECT count(*)::int FROM patrol_routes pr
         WHERE pr.building_id ${ANY_BUILDING_IDS_FRAGMENT} AND pr.status = 'INACTIVE')
         AS routes_inactive,
       (SELECT count(*)::int FROM generated_tasks gt
         JOIN patrol_schedule_bindings psb ON psb.schedule_definition_id = gt.schedule_definition_id
         JOIN patrol_routes pr ON pr.id = psb.patrol_route_id
         WHERE gt.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND psb.status = 'ACTIVE'
           AND pr.status = 'ACTIVE'
           AND ($2::timestamptz IS NULL OR gt.occurrence_at >= $2)
           AND ($3::timestamptz IS NULL OR gt.occurrence_at < $3)
           AND gt.status IN ('OPEN','ASSIGNED'))
         AS patrols_scheduled,
       (SELECT count(*)::int FROM generated_tasks gt
         JOIN patrol_schedule_bindings psb ON psb.schedule_definition_id = gt.schedule_definition_id
         JOIN patrol_routes pr ON pr.id = psb.patrol_route_id
         WHERE gt.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND psb.status = 'ACTIVE'
           AND pr.status = 'ACTIVE'
           AND ($2::timestamptz IS NULL OR gt.occurrence_at >= $2)
           AND ($3::timestamptz IS NULL OR gt.occurrence_at < $3)
           AND gt.status = 'IN_PROGRESS')
         AS patrols_in_progress,
       (SELECT count(*)::int FROM generated_tasks gt
         JOIN patrol_schedule_bindings psb ON psb.schedule_definition_id = gt.schedule_definition_id
         JOIN patrol_routes pr ON pr.id = psb.patrol_route_id
         WHERE gt.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND psb.status = 'ACTIVE'
           AND pr.status = 'ACTIVE'
           AND ($2::timestamptz IS NULL OR gt.occurrence_at >= $2)
           AND ($3::timestamptz IS NULL OR gt.occurrence_at < $3)
           AND gt.status = 'COMPLETED')
         AS patrols_completed,
       (SELECT count(*)::int FROM generated_tasks gt
         JOIN patrol_schedule_bindings psb ON psb.schedule_definition_id = gt.schedule_definition_id
         JOIN patrol_routes pr ON pr.id = psb.patrol_route_id
         WHERE gt.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND psb.status = 'ACTIVE'
           AND pr.status = 'ACTIVE'
           AND ($2::timestamptz IS NULL OR gt.occurrence_at >= $2)
           AND ($3::timestamptz IS NULL OR gt.occurrence_at < $3)
           AND gt.status = 'CANCELLED')
         AS patrols_cancelled,
       (SELECT count(*)::int FROM checklist_executions ce
         JOIN patrol_checklist_bindings pcb ON pcb.id = ce.patrol_checklist_binding_id
         WHERE pcb.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND ($2::timestamptz IS NULL OR ce.created_at >= $2)
           AND ($3::timestamptz IS NULL OR ce.created_at < $3)
           AND ce.status IN ('DRAFT','IN_PROGRESS'))
         AS checklists_open,
       (SELECT count(*)::int FROM checklist_executions ce
         JOIN patrol_checklist_bindings pcb ON pcb.id = ce.patrol_checklist_binding_id
         WHERE pcb.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND ($2::timestamptz IS NULL OR ce.created_at >= $2)
           AND ($3::timestamptz IS NULL OR ce.created_at < $3)
           AND ce.status = 'COMPLETED')
         AS checklists_completed,
       (SELECT count(*)::int FROM findings f
         JOIN security_finding_links sfl ON sfl.finding_id = f.id
         WHERE sfl.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND ($2::timestamptz IS NULL OR f.reported_at >= $2)
           AND ($3::timestamptz IS NULL OR f.reported_at < $3)
           AND f.status IN (
             'OPEN','ASSIGNED','IN_PROGRESS','PENDING_REVIEW',
             'REWORK_REQUIRED','RESUBMITTED','REJECTED'))
         AS findings_open,
       (SELECT count(*)::int FROM findings f
         JOIN security_finding_links sfl ON sfl.finding_id = f.id
         WHERE sfl.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND ($2::timestamptz IS NULL OR f.state_changed_at >= $2)
           AND ($3::timestamptz IS NULL OR f.state_changed_at < $3)
           AND f.status = 'VERIFIED')
         AS findings_verified,
       (SELECT count(*)::int FROM findings f
         JOIN security_finding_links sfl ON sfl.finding_id = f.id
         WHERE sfl.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND ($2::timestamptz IS NULL OR f.state_changed_at >= $2)
           AND ($3::timestamptz IS NULL OR f.state_changed_at < $3)
           AND f.status = 'CLOSED')
         AS findings_closed,
       (SELECT count(*)::int FROM security_shift_handover_bindings sshb
         WHERE sshb.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sshb.status = 'ACTIVE')
         AS shift_handovers_active,
       (SELECT count(*)::int FROM shift_handovers sh
         WHERE sh.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND EXISTS (SELECT 1 FROM security_shift_handover_bindings sshb
                       WHERE sshb.shift_handover_id = sh.id
                         AND sshb.building_id ${ANY_BUILDING_IDS_FRAGMENT}
                         AND sshb.status = 'ACTIVE')
           AND ($2::timestamptz IS NULL OR sh.created_at >= $2)
           AND ($3::timestamptz IS NULL OR sh.created_at < $3)
           AND sh.status = 'DRAFT')
         AS shift_handovers_draft,
       (SELECT count(*)::int FROM shift_handovers sh
         WHERE sh.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND EXISTS (SELECT 1 FROM security_shift_handover_bindings sshb
                       WHERE sshb.shift_handover_id = sh.id
                         AND sshb.building_id ${ANY_BUILDING_IDS_FRAGMENT}
                         AND sshb.status = 'ACTIVE')
           AND ($2::timestamptz IS NULL OR sh.created_at >= $2)
           AND ($3::timestamptz IS NULL OR sh.created_at < $3)
           AND sh.status = 'READY')
         AS shift_handovers_ready,
       (SELECT count(*)::int FROM shift_handovers sh
         WHERE sh.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND EXISTS (SELECT 1 FROM security_shift_handover_bindings sshb
                       WHERE sshb.shift_handover_id = sh.id
                         AND sshb.building_id ${ANY_BUILDING_IDS_FRAGMENT}
                         AND sshb.status = 'ACTIVE')
           AND ($2::timestamptz IS NULL OR sh.created_at >= $2)
           AND ($3::timestamptz IS NULL OR sh.created_at < $3)
           AND sh.status = 'ACKNOWLEDGED')
         AS shift_handovers_acknowledged,
       (SELECT count(*)::int FROM security_incident_readiness sir
         WHERE sir.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sir.readiness_status = 'NOT_READY'
           AND sir.status = 'ACTIVE')
         AS incident_readiness_not_ready,
       (SELECT count(*)::int FROM security_incident_readiness sir
         WHERE sir.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sir.readiness_status = 'PARTIAL'
           AND sir.status = 'ACTIVE')
         AS incident_readiness_partial,
       (SELECT count(*)::int FROM security_incident_readiness sir
         WHERE sir.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sir.readiness_status = 'READY'
           AND sir.status = 'ACTIVE')
         AS incident_readiness_ready,
       (SELECT count(*)::int FROM security_incident_readiness sir
         WHERE sir.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sir.status = 'ACTIVE')
         AS incident_readiness_active,
       (SELECT count(*)::int FROM security_visitor_bindings svb
         WHERE svb.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND svb.status = 'ACTIVE')
         AS visitor_bindings_active,
       (SELECT count(*)::int FROM security_visitor_bindings svb
         WHERE svb.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND svb.status = 'INACTIVE')
         AS visitor_bindings_inactive,
       (SELECT count(*)::int FROM security_keys sk
         WHERE sk.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sk.status = 'AVAILABLE')
         AS keys_available,
       (SELECT count(*)::int FROM security_keys sk
         WHERE sk.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sk.status = 'ISSUED')
         AS keys_issued,
       (SELECT count(*)::int FROM security_keys sk
         WHERE sk.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sk.status = 'OVERDUE')
         AS keys_overdue,
       (SELECT count(*)::int FROM security_keys sk
         WHERE sk.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sk.status = 'LOST')
         AS keys_lost,
       (SELECT count(*)::int FROM security_keys sk
         WHERE sk.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND sk.status = 'INACTIVE')
         AS keys_inactive,
       (SELECT count(*)::int FROM security_key_custody skc
         JOIN security_keys sk ON sk.id = skc.key_id
         WHERE sk.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND skc.transaction_type = 'ISSUE'
           AND skc.returned_at IS NULL)
         AS keys_open_custody,
       (SELECT count(*)::int FROM security_lost_found slf
         WHERE slf.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND slf.custody_status = 'FOUND')
         AS lost_found_found,
       (SELECT count(*)::int FROM security_lost_found slf
         WHERE slf.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND slf.custody_status = 'IN_CUSTODY')
         AS lost_found_in_custody,
       (SELECT count(*)::int FROM security_lost_found slf
         WHERE slf.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND slf.custody_status = 'CLAIMED')
         AS lost_found_claimed,
       (SELECT count(*)::int FROM security_lost_found slf
         WHERE slf.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND slf.custody_status = 'RETURNED')
         AS lost_found_returned,
       (SELECT count(*)::int FROM security_lost_found slf
         WHERE slf.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND slf.custody_status = 'DISPOSED')
         AS lost_found_disposed,
       (SELECT count(*)::int FROM security_lost_found slf
         WHERE slf.building_id ${ANY_BUILDING_IDS_FRAGMENT}
           AND slf.custody_status = 'CLOSED')
         AS lost_found_closed`,
    [buildingIds, start, end],
  );
  return result.rows[0];
}

/* ------------------------------------------------------------------ */
/*  Patrol dataset                                                     */
/* ------------------------------------------------------------------ */

type PatrolRow = {
  task_id: string;
  /** `psb.id` — INNER JOIN on an ACTIVE binding, so never NULL. See PublicPatrolDatasetRow. */
  patrol_schedule_binding_id: string;
  patrol_route_id: string;
  patrol_route_code: string;
  patrol_route_name: string;
  start_security_post_id: string | null;
  start_security_post_code: string | null;
  start_security_post_name: string | null;
  status: string;
  occurrence_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
};

export async function getPatrolDataset(
  buildingIds: string[],
  filters: SecurityReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicPatrolDatasetRow[]> {
  const conditions: string[] = [
    'gt.building_id = ANY($1::uuid[])',
    'psb.status = \'ACTIVE\'',
    'pr.status = \'ACTIVE\'',
  ];
  const values: unknown[] = [buildingIds];

  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(
      `COALESCE(psb.start_security_post_id, pr.start_security_post_id) = $${values.length}`,
    );
  }
  if (filters.patrolRouteId) {
    values.push(filters.patrolRouteId);
    conditions.push(`pr.id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`gt.status = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`gt.occurrence_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`gt.occurrence_at < $${values.length}`);
  }

  const result = await getPool().query<PatrolRow>(
    `SELECT
       gt.id AS task_id,
       psb.id AS patrol_schedule_binding_id,
       pr.id AS patrol_route_id,
       pr.code AS patrol_route_code,
       pr.name AS patrol_route_name,
       COALESCE(psb.start_security_post_id, pr.start_security_post_id) AS start_security_post_id,
       sp.code AS start_security_post_code,
       sp.name AS start_security_post_name,
       gt.status AS status,
       gt.occurrence_at AS occurrence_at,
       gt.started_at AS started_at,
       gt.completed_at AS completed_at,
       gt.completed_by_user_id AS completed_by_user_id
     FROM generated_tasks gt
     JOIN patrol_schedule_bindings psb
       ON psb.schedule_definition_id = gt.schedule_definition_id
     JOIN patrol_routes pr
       ON pr.id = psb.patrol_route_id
     LEFT JOIN security_posts sp
       ON sp.id = COALESCE(psb.start_security_post_id, pr.start_security_post_id)
     WHERE ${conditions.join(' AND ')}
     ORDER BY gt.occurrence_at DESC, gt.created_at DESC`,
    values,
  );

  return result.rows.map((row) => ({
    taskId: row.task_id,
    // Copied verbatim. It identifies the joined ACTIVE binding for this row; no binding is
    // elected, ranked or preferred, and repeated task_id rows are never collapsed.
    patrolScheduleBindingId: row.patrol_schedule_binding_id,
    patrolRouteId: row.patrol_route_id,
    patrolRouteCode: row.patrol_route_code,
    patrolRouteName: row.patrol_route_name,
    securityPostId: row.start_security_post_id,
    securityPostCode: row.start_security_post_code,
    securityPostName: row.start_security_post_name,
    status: row.status,
    occurrenceAt: row.occurrence_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    completedByUserId: row.completed_by_user_id,
  }));
}

/* ------------------------------------------------------------------ */
/*  Security Post dataset                                              */
/* ------------------------------------------------------------------ */

type SecurityPostRow = {
  security_post_id: string;
  code: string;
  name: string;
  post_type: string;
  status: string;
  patrol_route_count: number;
  open_patrol_count: number;
};

export async function getSecurityPostDataset(
  buildingIds: string[],
  filters: SecurityReportFilters,
): Promise<PublicSecurityPostDatasetRow[]> {
  const values: unknown[] = [buildingIds];
  const conditions: string[] = ['sp.building_id = ANY($1::uuid[])'];
  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(`sp.id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`sp.status = $${values.length}`);
  }

  const result = await getPool().query<SecurityPostRow>(
    `SELECT
       sp.id AS security_post_id,
       sp.code AS code,
       sp.name AS name,
       sp.post_type AS post_type,
       sp.status AS status,
       (SELECT count(*)::int FROM patrol_routes pr
         WHERE pr.building_id = sp.building_id
           AND (pr.start_security_post_id = sp.id
                OR EXISTS (SELECT 1 FROM patrol_schedule_bindings psb2
                           WHERE psb2.patrol_route_id = pr.id
                             AND psb2.start_security_post_id = sp.id
                             AND psb2.status = 'ACTIVE'))
           AND pr.status = 'ACTIVE')
         AS patrol_route_count,
       (SELECT count(*)::int FROM generated_tasks gt
         JOIN patrol_schedule_bindings psb
           ON psb.schedule_definition_id = gt.schedule_definition_id
         JOIN patrol_routes pr
           ON pr.id = psb.patrol_route_id
         WHERE gt.building_id = sp.building_id
           AND (psb.start_security_post_id = sp.id
                OR pr.start_security_post_id = sp.id)
           AND psb.status = 'ACTIVE'
           AND pr.status = 'ACTIVE'
           AND gt.status IN ('OPEN','ASSIGNED','IN_PROGRESS'))
         AS open_patrol_count
     FROM security_posts sp
     WHERE ${conditions.join(' AND ')}
     ORDER BY sp.code ASC`,
    values,
  );

  return result.rows.map((row) => ({
    securityPostId: row.security_post_id,
    code: row.code,
    name: row.name,
    postType: row.post_type,
    status: row.status,
    patrolRouteCount: row.patrol_route_count,
    openPatrolCount: row.open_patrol_count,
  }));
}

/* ------------------------------------------------------------------ */
/*  Security Finding dataset                                            */
/* ------------------------------------------------------------------ */

type SecurityFindingRow = {
  link_id: string;
  finding_id: string;
  finding_number: string;
  finding_title: string;
  finding_status: string;
  link_status: string;
  source_post_id: string | null;
  source_post_code: string | null;
  source_route_id: string | null;
  source_route_code: string | null;
  reported_at: Date;
};

export async function getSecurityFindingDataset(
  buildingIds: string[],
  filters: SecurityReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicSecurityFindingDatasetRow[]> {
  const conditions: string[] = ['sfl.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.status) {
    values.push(filters.status);
    conditions.push(`f.status = $${values.length}`);
  }
  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(`sfl.start_security_post_id = $${values.length}`);
  }
  if (filters.patrolRouteId) {
    values.push(filters.patrolRouteId);
    conditions.push(`sfl.patrol_route_id = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`f.reported_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`f.reported_at < $${values.length}`);
  }

  const result = await getPool().query<SecurityFindingRow>(
    `SELECT
       sfl.id AS link_id,
       f.id AS finding_id,
       f.finding_number AS finding_number,
       f.title AS finding_title,
       f.status AS finding_status,
       'ACTIVE' AS link_status,
       sfl.start_security_post_id AS source_post_id,
       sp.code AS source_post_code,
       sfl.patrol_route_id AS source_route_id,
       pr.code AS source_route_code,
       f.reported_at AS reported_at
     FROM security_finding_links sfl
     JOIN findings f ON f.id = sfl.finding_id
     LEFT JOIN security_posts sp ON sp.id = sfl.start_security_post_id
     LEFT JOIN patrol_routes pr ON pr.id = sfl.patrol_route_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY f.reported_at DESC, sfl.created_at DESC`,
    values,
  );

  return result.rows.map((row) => ({
    linkId: row.link_id,
    findingId: row.finding_id,
    findingNumber: row.finding_number,
    findingTitle: row.finding_title,
    findingStatus: row.finding_status,
    linkStatus: row.link_status,
    sourcePostId: row.source_post_id,
    sourcePostCode: row.source_post_code,
    sourceRouteId: row.source_route_id,
    sourceRouteCode: row.source_route_code,
    reportedAt: row.reported_at.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/*  Shift Handover dataset                                              */
/* ------------------------------------------------------------------ */

type ShiftHandoverRow = {
  binding_id: string;
  shift_handover_id: string;
  start_security_post_id: string | null;
  start_security_post_code: string | null;
  patrol_route_id: string | null;
  patrol_route_code: string | null;
  binding_status: string;
  handover_status: string;
  handover_created_at: Date;
};

export async function getShiftHandoverDataset(
  buildingIds: string[],
  filters: SecurityReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicShiftHandoverDatasetRow[]> {
  const conditions: string[] = ['sshb.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(`sshb.start_security_post_id = $${values.length}`);
  }
  if (filters.patrolRouteId) {
    values.push(filters.patrolRouteId);
    conditions.push(`sshb.patrol_route_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`sh.status = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`sh.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`sh.created_at < $${values.length}`);
  }

  const result = await getPool().query<ShiftHandoverRow>(
    `SELECT
       sshb.id AS binding_id,
       sh.id AS shift_handover_id,
       sshb.start_security_post_id AS start_security_post_id,
       sp.code AS start_security_post_code,
       sshb.patrol_route_id AS patrol_route_id,
       pr.code AS patrol_route_code,
       sshb.status AS binding_status,
       sh.status AS handover_status,
       sh.created_at AS handover_created_at
     FROM security_shift_handover_bindings sshb
     JOIN shift_handovers sh ON sh.id = sshb.shift_handover_id
     LEFT JOIN security_posts sp ON sp.id = sshb.start_security_post_id
     LEFT JOIN patrol_routes pr ON pr.id = sshb.patrol_route_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY sh.created_at DESC, sshb.created_at DESC`,
    values,
  );

  return result.rows.map((row) => ({
    bindingId: row.binding_id,
    shiftHandoverId: row.shift_handover_id,
    startSecurityPostId: row.start_security_post_id,
    startSecurityPostCode: row.start_security_post_code,
    patrolRouteId: row.patrol_route_id,
    patrolRouteCode: row.patrol_route_code,
    bindingStatus: row.binding_status,
    handoverStatus: row.handover_status,
    handoverCreatedAt: row.handover_created_at.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/*  Incident Readiness dataset                                          */
/* ------------------------------------------------------------------ */

type IncidentReadinessRow = {
  binding_id: string;
  building_id: string;
  security_post_id: string | null;
  security_post_code: string | null;
  category: string;
  status: string;
  team_id: string | null;
  team_name: string | null;
  primary_workforce_id: string | null;
  primary_workforce_full_name: string | null;
  updated_at: Date;
};

export async function getIncidentReadinessDataset(
  buildingIds: string[],
  filters: SecurityReportFilters,
): Promise<PublicIncidentReadinessDatasetRow[]> {
  const conditions: string[] = ['sir.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(`sir.security_post_id = $${values.length}`);
  }
  if (filters.teamId) {
    values.push(filters.teamId);
    conditions.push(`sir.responsible_team_id = $${values.length}`);
  }
  if (filters.workforceId) {
    values.push(filters.workforceId);
    conditions.push(`sir.responsible_workforce_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`sir.readiness_status = $${values.length}`);
  }
  if (filters.category) {
    values.push(filters.category);
    conditions.push(`sir.category = $${values.length}`);
  }

  const result = await getPool().query<IncidentReadinessRow>(
    `SELECT
       sir.id AS binding_id,
       sir.building_id AS building_id,
       sir.security_post_id AS security_post_id,
       sp.code AS security_post_code,
       sir.category AS category,
       sir.readiness_status AS status,
       sir.responsible_team_id AS team_id,
       t.name AS team_name,
       sir.responsible_workforce_id AS primary_workforce_id,
       wp.full_name AS primary_workforce_full_name,
       sir.updated_at AS updated_at
     FROM security_incident_readiness sir
     LEFT JOIN security_posts sp ON sp.id = sir.security_post_id
     LEFT JOIN teams t ON t.id = sir.responsible_team_id
     LEFT JOIN workforce_profiles wp ON wp.id = sir.responsible_workforce_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY sir.updated_at DESC, sir.created_at DESC`,
    values,
  );

  return result.rows.map((row) => ({
    bindingId: row.binding_id,
    buildingId: row.building_id,
    securityPostId: row.security_post_id,
    securityPostCode: row.security_post_code,
    category: row.category,
    status: row.status,
    teamId: row.team_id,
    teamName: row.team_name,
    primaryWorkforceId: row.primary_workforce_id,
    primaryWorkforceName: row.primary_workforce_full_name,
    updatedAt: row.updated_at.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/*  Visitor Binding dataset                                             */
/* ------------------------------------------------------------------ */

type VisitorBindingRow = {
  binding_id: string;
  building_id: string;
  security_post_id: string | null;
  security_post_code: string | null;
  external_visit_reference: string;
  security_workforce_id: string | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

export async function getVisitorBindingDataset(
  buildingIds: string[],
  filters: SecurityReportFilters,
): Promise<PublicVisitorBindingDatasetRow[]> {
  const conditions: string[] = ['svb.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(`svb.security_post_id = $${values.length}`);
  }
  if (filters.workforceId) {
    values.push(filters.workforceId);
    conditions.push(`svb.security_workforce_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`svb.status = $${values.length}`);
  }

  const result = await getPool().query<VisitorBindingRow>(
    `SELECT
       svb.id AS binding_id,
       svb.building_id AS building_id,
       svb.security_post_id AS security_post_id,
       sp.code AS security_post_code,
       svb.external_visit_reference AS external_visit_reference,
       svb.security_workforce_id AS security_workforce_id,
       svb.status AS status,
       svb.created_at AS created_at,
       svb.updated_at AS updated_at
     FROM security_visitor_bindings svb
     LEFT JOIN security_posts sp ON sp.id = svb.security_post_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY svb.created_at DESC, svb.updated_at DESC`,
    values,
  );

  return result.rows.map((row) => ({
    bindingId: row.binding_id,
    buildingId: row.building_id,
    securityPostId: row.security_post_id,
    securityPostCode: row.security_post_code,
    externalVisitReference: row.external_visit_reference,
    securityWorkforceId: row.security_workforce_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/*  Key Control dataset                                                 */
/* ------------------------------------------------------------------ */

type KeyControlRow = {
  key_id: string;
  code: string;
  name: string;
  status: string;
  security_post_id: string | null;
  security_post_code: string | null;
  has_open_custody: boolean;
  open_custody_workforce_id: string | null;
  updated_at: Date;
};

export async function getKeyControlDataset(
  buildingIds: string[],
  filters: SecurityReportFilters,
): Promise<PublicKeyControlDatasetRow[]> {
  const conditions: string[] = ['sk.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(`sk.security_post_id = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`sk.status = $${values.length}`);
  }
  if (filters.workforceId) {
    values.push(filters.workforceId);
    conditions.push(`EXISTS (
       SELECT 1 FROM security_key_custody skc
       WHERE skc.key_id = sk.id
         AND skc.issued_to_workforce_id = $${values.length}
         AND skc.transaction_type = 'ISSUE'
         AND skc.returned_at IS NULL
     )`);
  }

  const result = await getPool().query<KeyControlRow>(
    `SELECT
       sk.id AS key_id,
       sk.code AS code,
       sk.name AS name,
       sk.status AS status,
       sk.security_post_id AS security_post_id,
       sp.code AS security_post_code,
       EXISTS (
         SELECT 1 FROM security_key_custody skc
         WHERE skc.key_id = sk.id
           AND skc.transaction_type = 'ISSUE'
           AND skc.returned_at IS NULL
       ) AS has_open_custody,
       (SELECT skc.issued_to_workforce_id
         FROM security_key_custody skc
         WHERE skc.key_id = sk.id
           AND skc.transaction_type = 'ISSUE'
           AND skc.returned_at IS NULL
         ORDER BY skc.issued_at DESC
         LIMIT 1) AS open_custody_workforce_id,
       sk.updated_at AS updated_at
     FROM security_keys sk
     LEFT JOIN security_posts sp ON sp.id = sk.security_post_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY sk.code ASC`,
    values,
  );

  return result.rows.map((row) => ({
    keyId: row.key_id,
    code: row.code,
    name: row.name,
    status: row.status,
    securityPostId: row.security_post_id,
    securityPostCode: row.security_post_code,
    hasOpenCustody: row.has_open_custody,
    openCustodyWorkforceId: row.open_custody_workforce_id,
    updatedAt: row.updated_at.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/*  Lost & Found dataset                                                */
/* ------------------------------------------------------------------ */

type LostFoundRow = {
  record_id: string;
  item_code: string;
  item_name: string;
  custody_status: string;
  security_post_id: string | null;
  security_post_code: string | null;
  found_at: Date;
  has_active_claim: boolean;
  updated_at: Date;
};

export async function getLostFoundDataset(
  buildingIds: string[],
  filters: SecurityReportFilters,
  start: Date | null,
  end: Date | null,
): Promise<PublicLostFoundDatasetRow[]> {
  const conditions: string[] = ['slf.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(`slf.security_post_id = $${values.length}`);
  }
  const effectiveStatus = filters.custodyStatus ?? filters.status;
  if (effectiveStatus) {
    values.push(effectiveStatus);
    conditions.push(`slf.custody_status = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`slf.found_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`slf.found_at < $${values.length}`);
  }

  const result = await getPool().query<LostFoundRow>(
    `SELECT
       slf.id AS record_id,
       slf.item_code AS item_code,
       slf.item_name AS item_name,
       slf.custody_status AS custody_status,
       slf.security_post_id AS security_post_id,
       sp.code AS security_post_code,
       slf.found_at AS found_at,
       EXISTS (
         SELECT 1 FROM security_lost_found_history h
         WHERE h.lost_found_id = slf.id
           AND h.event_type = 'CLAIM_REGISTER'
           AND NOT EXISTS (
             SELECT 1 FROM security_lost_found_history h2
             WHERE h2.lost_found_id = slf.id
               AND h2.event_type IN ('RETURN','DISPOSE','CLOSE')
               AND h2.occurred_at >= h.occurred_at
           )
       ) AS has_active_claim,
       slf.updated_at AS updated_at
     FROM security_lost_found slf
     LEFT JOIN security_posts sp ON sp.id = slf.security_post_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY slf.found_at DESC, slf.created_at DESC`,
    values,
  );

  return result.rows.map((row) => ({
    recordId: row.record_id,
    itemCode: row.item_code,
    itemName: row.item_name,
    custodyStatus: row.custody_status,
    securityPostId: row.security_post_id,
    securityPostCode: row.security_post_code,
    foundAt: row.found_at.toISOString(),
    hasActiveClaim: row.has_active_claim,
    updatedAt: row.updated_at.toISOString(),
  }));
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Re-export the shared report-range helper for the service layer. */
export { reportRange };

/**
 * Convert a raw `SecuritySummaryRow` into the public representation.
 * The summary is intentionally flat — every counter is sourced from
 * the authoritative BE-12 records themselves.
 */
export function toPublicSecuritySummary(
  buildingId: string | null,
  buildingScope: string[],
  start: Date | null,
  end: Date | null,
  row: SecuritySummaryRow,
): PublicSecuritySummary {
  return {
    buildingId,
    dateFrom: start ? start.toISOString() : null,
    dateTo: end ? end.toISOString() : null,
    buildingScope,
    posts: {
      total: row.posts_total,
      active: row.posts_active,
      inactive: row.posts_inactive,
    },
    patrolRoutes: {
      total: row.routes_total,
      active: row.routes_active,
      inactive: row.routes_inactive,
    },
    patrols: {
      scheduled: row.patrols_scheduled,
      inProgress: row.patrols_in_progress,
      completed: row.patrols_completed,
      cancelled: row.patrols_cancelled,
    },
    checklists: {
      openExecutions: row.checklists_open,
      completedExecutions: row.checklists_completed,
    },
    findings: {
      open: row.findings_open,
      verified: row.findings_verified,
      closed: row.findings_closed,
    },
    shiftHandovers: {
      activeBindings: row.shift_handovers_active,
      draftHandovers: row.shift_handovers_draft,
      readyHandovers: row.shift_handovers_ready,
      acknowledgedHandovers: row.shift_handovers_acknowledged,
    },
    incidentReadiness: {
      notReady: row.incident_readiness_not_ready,
      partial: row.incident_readiness_partial,
      ready: row.incident_readiness_ready,
      activeBindings: row.incident_readiness_active,
    },
    visitorBindings: {
      active: row.visitor_bindings_active,
      inactive: row.visitor_bindings_inactive,
    },
    keyControl: {
      available: row.keys_available,
      issued: row.keys_issued,
      overdue: row.keys_overdue,
      lost: row.keys_lost,
      inactive: row.keys_inactive,
      openCustodyRows: row.keys_open_custody,
    },
    lostFound: {
      found: row.lost_found_found,
      inCustody: row.lost_found_in_custody,
      claimed: row.lost_found_claimed,
      returned: row.lost_found_returned,
      disposed: row.lost_found_disposed,
      closed: row.lost_found_closed,
    },
  };
}

export const securityReportRepository = {
  getIncidentReadinessDataset,
  getKeyControlDataset,
  getLostFoundDataset,
  getPatrolDataset,
  getSecurityFindingDataset,
  getSecurityPostDataset,
  getSecuritySummary,
  getShiftHandoverDataset,
  getVisitorBindingDataset,
  toPublicSecuritySummary,
};

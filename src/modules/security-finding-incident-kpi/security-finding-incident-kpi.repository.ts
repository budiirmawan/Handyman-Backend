import { getPool } from '../../database';
import type {
  PublicKpiStatusCount,
  SecurityFindingIncidentKpiFilters,
} from './security-finding-incident-kpi.types';

/**
 * BE-23F2 — Security Finding / Incident / Handover KPI repository.
 *
 * Three direct read queries over the authoritative BE-09 / BE-21 /
 * BE-10J + BE-12 records. One statement per KPI block, no N+1, no ETL,
 * no duplicated operational tables, no writes.
 *
 * SCOPING RULES
 * -------------
 * Findings   BE-09 `findings` reached through the BE-12H
 *            `security_finding_links` binding — that binding IS the
 *            definition of "a Security finding", so the KPI can never
 *            disagree with BE-12M about which findings are Security's.
 *            Windowed on `reported_at` (when it arose), matching the
 *            BE-12M finding dataset.
 *
 * Incidents  BE-21A `incidents` narrowed to the Security-relevant set:
 *            a BE-21B operational incident categorised SECURITY, or a
 *            BE-21D finding escalation whose Finding carries a BE-12H
 *            Security binding. Without this narrowing the KPI would
 *            report every Engineering/Housekeeping incident in the
 *            Building as Security's, which is simply wrong.
 *            Windowed on `reported_at`.
 *
 * Handovers  BE-10J `shift_handovers` surfaced through an ACTIVE BE-12G
 *            binding, exactly as BE-12M does. Windowed on `created_at`.
 *
 * Statuses are counted with FILTER rather than fetched-and-tallied in
 * JS, so a Building with a large history costs one aggregate scan.
 */

/* ------------------------------------------------------------------ */
/*  Findings                                                           */
/* ------------------------------------------------------------------ */

export type FindingKpiRow = {
  total: number;
  open: number;
  assigned: number;
  in_progress: number;
  pending_review: number;
  rejected: number;
  rework_required: number;
  resubmitted: number;
  verified: number;
  closed: number;
  cancelled: number;
  outstanding: number;
};

export const EMPTY_FINDING_KPI_ROW: FindingKpiRow = {
  total: 0,
  open: 0,
  assigned: 0,
  in_progress: 0,
  pending_review: 0,
  rejected: 0,
  rework_required: 0,
  resubmitted: 0,
  verified: 0,
  closed: 0,
  cancelled: 0,
  outstanding: 0,
};

/** Statuses that still demand operational attention (BE-23F2 authority). */
export const SECURITY_OUTSTANDING_FINDING_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REJECTED',
  'REWORK_REQUIRED',
  'RESUBMITTED',
] as const;

const OUTSTANDING_FINDING_STATUSES_SQL = `(${SECURITY_OUTSTANDING_FINDING_STATUSES
  .map((status) => `'${status}'`)
  .join(',')})`;

export async function getFindingKpi(
  buildingIds: string[],
  filters: SecurityFindingIncidentKpiFilters,
  start: Date | null,
  end: Date | null,
): Promise<FindingKpiRow> {
  const conditions: string[] = ['sfl.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

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

  const result = await getPool().query<FindingKpiRow>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE f.status = 'OPEN')::int AS open,
       count(*) FILTER (WHERE f.status = 'ASSIGNED')::int AS assigned,
       count(*) FILTER (WHERE f.status = 'IN_PROGRESS')::int AS in_progress,
       count(*) FILTER (WHERE f.status = 'PENDING_REVIEW')::int AS pending_review,
       count(*) FILTER (WHERE f.status = 'REJECTED')::int AS rejected,
       count(*) FILTER (WHERE f.status = 'REWORK_REQUIRED')::int AS rework_required,
       count(*) FILTER (WHERE f.status = 'RESUBMITTED')::int AS resubmitted,
       count(*) FILTER (WHERE f.status = 'VERIFIED')::int AS verified,
       count(*) FILTER (WHERE f.status = 'CLOSED')::int AS closed,
       count(*) FILTER (WHERE f.status = 'CANCELLED')::int AS cancelled,
       count(*) FILTER (
         WHERE f.status IN ${OUTSTANDING_FINDING_STATUSES_SQL}
       )::int AS outstanding
     FROM findings f
     JOIN security_finding_links sfl ON sfl.finding_id = f.id
     WHERE ${conditions.join(' AND ')}`,
    values,
  );

  return result.rows[0] ?? { ...EMPTY_FINDING_KPI_ROW };
}

/* ------------------------------------------------------------------ */
/*  Incidents                                                          */
/* ------------------------------------------------------------------ */

export type IncidentKpiRow = {
  total: number;
  reported: number;
  cancelled: number;
  closed: number;
  type_operational: number;
  type_asset_failure: number;
  type_finding_escalation: number;
  severity_low: number;
  severity_medium: number;
  severity_high: number;
  severity_critical: number;
  operational_open: number;
  operational_in_progress: number;
  operational_resolved: number;
};

export const EMPTY_INCIDENT_KPI_ROW: IncidentKpiRow = {
  total: 0,
  reported: 0,
  cancelled: 0,
  closed: 0,
  type_operational: 0,
  type_asset_failure: 0,
  type_finding_escalation: 0,
  severity_low: 0,
  severity_medium: 0,
  severity_high: 0,
  severity_critical: 0,
  operational_open: 0,
  operational_in_progress: 0,
  operational_resolved: 0,
};

export async function getIncidentKpi(
  buildingIds: string[],
  filters: SecurityFindingIncidentKpiFilters,
  start: Date | null,
  end: Date | null,
): Promise<IncidentKpiRow> {
  const conditions: string[] = ['i.building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.incidentType) {
    values.push(filters.incidentType);
    conditions.push(`i.incident_type = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`i.reported_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`i.reported_at < $${values.length}`);
  }

  // Security relevance. A post filter narrows to escalations reachable
  // through a Security Finding bound to that Post, since a BE-21A
  // Incident carries no Security Post of its own.
  const escalationConditions = ['sfl2.finding_id = fei.finding_id'];
  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    escalationConditions.push(
      `sfl2.start_security_post_id = $${values.length}`,
    );
  }
  if (filters.patrolRouteId) {
    values.push(filters.patrolRouteId);
    escalationConditions.push(`sfl2.patrol_route_id = $${values.length}`);
  }

  const escalationBranch = `EXISTS (
         SELECT 1
           FROM finding_escalation_incidents fei
           JOIN security_finding_links sfl2
             ON ${escalationConditions.join(' AND ')}
          WHERE fei.incident_id = i.id
       )`;

  // An operational SECURITY incident only qualifies when no Security
  // Post / Route filter is active, because it has no Post binding to
  // match against.
  const securityRelevance =
    filters.securityPostId || filters.patrolRouteId
      ? escalationBranch
      : `(
         EXISTS (
           SELECT 1 FROM operational_incidents oi
            WHERE oi.incident_id = i.id
              AND oi.operational_category = 'SECURITY'
         )
         OR ${escalationBranch}
       )`;

  conditions.push(securityRelevance);

  const result = await getPool().query<IncidentKpiRow>(
    `SELECT
       count(*)::int AS total,
       count(*) FILTER (WHERE i.status = 'REPORTED')::int AS reported,
       count(*) FILTER (WHERE i.status = 'CANCELLED')::int AS cancelled,
       count(*) FILTER (WHERE i.status = 'CLOSED')::int AS closed,
       count(*) FILTER (WHERE i.incident_type = 'OPERATIONAL')::int
         AS type_operational,
       count(*) FILTER (WHERE i.incident_type = 'ASSET_FAILURE')::int
         AS type_asset_failure,
       count(*) FILTER (WHERE i.incident_type = 'FINDING_ESCALATION')::int
         AS type_finding_escalation,
       count(*) FILTER (WHERE i.severity = 'LOW')::int AS severity_low,
       count(*) FILTER (WHERE i.severity = 'MEDIUM')::int AS severity_medium,
       count(*) FILTER (WHERE i.severity = 'HIGH')::int AS severity_high,
       count(*) FILTER (WHERE i.severity = 'CRITICAL')::int AS severity_critical,
       count(*) FILTER (WHERE oi2.operational_status = 'OPEN')::int
         AS operational_open,
       count(*) FILTER (WHERE oi2.operational_status = 'IN_PROGRESS')::int
         AS operational_in_progress,
       count(*) FILTER (WHERE oi2.operational_status = 'RESOLVED')::int
         AS operational_resolved
     FROM incidents i
     LEFT JOIN operational_incidents oi2 ON oi2.incident_id = i.id
     WHERE ${conditions.join(' AND ')}`,
    values,
  );

  return result.rows[0] ?? { ...EMPTY_INCIDENT_KPI_ROW };
}

/* ------------------------------------------------------------------ */
/*  Shift handovers                                                    */
/* ------------------------------------------------------------------ */

export type HandoverKpiRow = {
  active_bindings: number;
  total: number;
  draft: number;
  ready: number;
  acknowledged: number;
  pending_acknowledgement: number;
};

export const EMPTY_HANDOVER_KPI_ROW: HandoverKpiRow = {
  active_bindings: 0,
  total: 0,
  draft: 0,
  ready: 0,
  acknowledged: 0,
  pending_acknowledgement: 0,
};

export async function getHandoverKpi(
  buildingIds: string[],
  filters: SecurityFindingIncidentKpiFilters,
  start: Date | null,
  end: Date | null,
): Promise<HandoverKpiRow> {
  const conditions: string[] = [
    'sshb.building_id = ANY($1::uuid[])',
    "sshb.status = 'ACTIVE'",
  ];
  const values: unknown[] = [buildingIds];

  if (filters.securityPostId) {
    values.push(filters.securityPostId);
    conditions.push(`sshb.start_security_post_id = $${values.length}`);
  }
  if (filters.patrolRouteId) {
    values.push(filters.patrolRouteId);
    conditions.push(`sshb.patrol_route_id = $${values.length}`);
  }
  if (start) {
    values.push(start);
    conditions.push(`sh.created_at >= $${values.length}`);
  }
  if (end) {
    values.push(end);
    conditions.push(`sh.created_at < $${values.length}`);
  }

  const result = await getPool().query<HandoverKpiRow>(
    `SELECT
       count(*)::int AS active_bindings,
       count(*)::int AS total,
       count(*) FILTER (WHERE sh.status = 'DRAFT')::int AS draft,
       count(*) FILTER (WHERE sh.status = 'READY')::int AS ready,
       count(*) FILTER (WHERE sh.status = 'ACKNOWLEDGED')::int AS acknowledged,
       count(*) FILTER (WHERE sh.status IN ('DRAFT','READY'))::int
         AS pending_acknowledgement
     FROM security_shift_handover_bindings sshb
     JOIN shift_handovers sh ON sh.id = sshb.shift_handover_id
     WHERE ${conditions.join(' AND ')}`,
    values,
  );

  return result.rows[0] ?? { ...EMPTY_HANDOVER_KPI_ROW };
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Builds the `byStatus` breakdown from already-counted values, dropping
 * zeroes and ordering by descending count then status name so the array
 * is stable and immediately useful for a table.
 */
export function toStatusCounts(
  entries: readonly (readonly [string, number])[],
): PublicKpiStatusCount[] {
  return entries
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

export const securityFindingIncidentKpiRepository = {
  getFindingKpi,
  getHandoverKpi,
  getIncidentKpi,
  toStatusCounts,
};

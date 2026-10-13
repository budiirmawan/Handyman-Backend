import {getPool} from '../../database';
import {resolveBuildingsForUser} from '../building-assignments';

/**
 * Read-only field feed. The logged-in user is the identity; never accept
 * a caller-owned tenant, building, crew, request or inspector locator.
 * Current Crew Lead is derived through the append-only lead sequence, not
 * historical designation or a role string. Building access is an INNER JOIN
 * at SQL level. No unconfirmed appointment is described as a booked visit.
 */
export const MY_JOBS_SQL = `
  SELECT DISTINCT es.id AS "executionScopeId", es.handyman_request_id AS "requestId",
    es.building_id AS "buildingId", a.handyman_crew_id AS "crewId",
    r.status AS "requestStatus", es.status AS "scopeStatus",
    booked.id AS "confirmedAppointmentId", booked.start_at AS "confirmedStartAt",
    booked.end_at AS "confirmedEndAt", booked.timezone AS "timezone"
  FROM handyman_execution_scopes es
  JOIN handyman_service_requests r ON r.id=es.handyman_request_id AND r.client_id=es.client_id
  JOIN handyman_execution_scope_assignments a ON a.execution_scope_id=es.id
    AND a.client_id=es.client_id AND a.status='ACTIVE'
  JOIN handyman_work_crews crew ON crew.id=a.handyman_crew_id
    AND crew.client_id=es.client_id AND crew.handyman_provider_context_id=a.handyman_provider_context_id
    AND crew.status='ACTIVE'
  -- Pick the actual latest designation BEFORE evaluating eligibility.
  -- An ineligible current Lead must never resurrect a historical Lead.
  JOIN LATERAL (
    SELECT cl.handyman_crew_membership_id, cl.client_id
    FROM handyman_crew_leads cl
    WHERE cl.handyman_crew_id=crew.id
    ORDER BY cl.lead_seq DESC LIMIT 1
  ) lead ON lead.client_id=es.client_id
  JOIN handyman_crew_memberships cm ON cm.id=lead.handyman_crew_membership_id
    AND cm.handyman_crew_id=crew.id AND cm.client_id=es.client_id AND cm.status='ACTIVE'
  JOIN handyman_worker_contexts wc ON wc.id=cm.handyman_worker_context_id
    AND wc.client_id=es.client_id AND wc.handyman_provider_context_id=a.handyman_provider_context_id
    AND wc.status='ACTIVE'
  JOIN workforce_profiles fp ON fp.id=wc.workforce_profile_id AND fp.status='ACTIVE'
  JOIN users u ON u.id=fp.user_id AND u.id=$1 AND u.status='ACTIVE'
  JOIN jsonb_to_recordset($2::jsonb) AS access("buildingId" uuid, "clientId" uuid)
    ON access."buildingId"=es.building_id AND access."clientId"=es.client_id
  JOIN buildings b ON b.id=es.building_id AND b.status='ACTIVE'
  JOIN properties p ON p.id=b.property_id AND p.client_id=es.client_id
  JOIN user_building_assignments uba ON uba.user_id=$1
    AND uba.building_id=es.building_id AND uba.status='ACTIVE'
  LEFT JOIN handyman_visit_appointments booked
    ON booked.execution_scope_id=es.id AND booked.kind='EXECUTION'
      AND booked.client_id=es.client_id AND booked.handyman_request_id=es.handyman_request_id
      AND booked.building_id=es.building_id AND booked.resource_type='CREW'
      AND booked.resource_id=a.handyman_crew_id
      AND booked.state IN ('CONFIRMED','IN_PROGRESS')
  WHERE es.status='AUTHORIZED'
  ORDER BY booked.start_at NULLS LAST, es.id DESC
  LIMIT 100`;

export const MY_INSPECTIONS_SQL = `
  SELECT v.id AS "appointmentId", v.handyman_request_id AS "requestId",
    v.building_id AS "buildingId", v.start_at AS "startAt", v.end_at AS "endAt",
    v.timezone, v.state, v.version
  FROM handyman_visit_appointments v
  JOIN users u ON u.id=$1 AND u.status='ACTIVE'
  JOIN jsonb_to_recordset($2::jsonb) AS access("buildingId" uuid, "clientId" uuid)
    ON access."buildingId"=v.building_id AND access."clientId"=v.client_id
  JOIN buildings b ON b.id=v.building_id AND b.status='ACTIVE'
  JOIN properties p ON p.id=b.property_id AND p.client_id=v.client_id
  JOIN user_building_assignments uba ON uba.user_id=u.id
    AND uba.building_id=v.building_id AND uba.status='ACTIVE'
  WHERE v.kind='INSPECTION' AND v.resource_type='INSPECTOR_USER'
    AND v.resource_id=u.id AND v.state IN ('CONFIRMED','IN_PROGRESS')
  ORDER BY v.start_at, v.id
  LIMIT 100`;

export async function readMyHandymanFieldFeed(actorUserId:string) {
  const db = getPool();
  // Reuse the shared authority, keeping exact Building + Client pairs (not
  // independent allowlists that could admit a cross-tenant combination).
  const contexts = await resolveBuildingsForUser(actorUserId);
  const access = JSON.stringify(contexts.filter(context => context.client !== null)
    .map(context => ({buildingId: context.building.id, clientId: context.client!.id})));
  const [jobs, inspections] = await Promise.all([
    db.query(MY_JOBS_SQL,[actorUserId, access]), db.query(MY_INSPECTIONS_SQL,[actorUserId, access]),
  ]);
  return {
    jobs: jobs.rows.map(row => ({...row, confirmedStartAt: row.confirmedStartAt?.toISOString() ?? null,
      confirmedEndAt: row.confirmedEndAt?.toISOString() ?? null,
      appointmentConfirmed: Boolean(row.confirmedAppointmentId)})),
    inspections: inspections.rows.map(row=>({...row,
      startAt: row.startAt.toISOString(),endAt:row.endAt.toISOString()})),
    feedSource:'AUTHORITATIVE_BACKEND',
  };
}

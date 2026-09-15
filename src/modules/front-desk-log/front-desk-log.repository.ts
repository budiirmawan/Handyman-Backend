import { getPool } from '../../database';
import type {
  FrontDeskActivityType,
  FrontDeskLogFilters,
  FrontDeskLogIdentity,
  FrontDeskLogRecord,
  FrontDeskSourceType,
} from './front-desk-log.types';

/**
 * Read-time union over authoritative BE-13 records. Every branch emits
 * the same reference shape; joins resolve Visitor/Visit identity instead
 * of copying it into a Front Desk Log table.
 */
const FRONT_DESK_EVENTS_CTE = `
WITH front_desk_events AS (
  SELECT
    'INVITATION_CREATED'::text AS activity_type,
    'VISITOR_INVITATION'::text AS source_type,
    vi.id AS source_id,
    vi.client_id,
    vi.building_id,
    vi.visitor_id,
    NULL::uuid AS expected_visitor_id,
    NULL::uuid AS walk_in_visit_id,
    NULL::uuid AS visit_check_in_id,
    vi.created_by_user_id AS actor_user_id,
    vi.created_at AS occurred_at,
    vi.notes
  FROM visitor_invitations vi

  UNION ALL

  SELECT
    'EXPECTED_VISITOR_REGISTERED', 'EXPECTED_VISITOR',
    ev.id, ev.client_id, ev.building_id, ev.visitor_id,
    ev.id, NULL::uuid, NULL::uuid,
    ev.created_by_user_id, ev.created_at, ev.notes
  FROM expected_visitors ev

  UNION ALL

  SELECT
    'WALK_IN_REGISTERED', 'WALK_IN_VISIT',
    wv.id, wv.client_id, wv.building_id, wv.visitor_id,
    NULL::uuid, wv.id, NULL::uuid,
    wv.created_by_user_id, wv.arrived_at, wv.front_desk_notes
  FROM walk_in_visits wv

  UNION ALL

  SELECT
    'HOST_CONFIRMATION_REQUESTED', 'HOST_CONFIRMATION',
    hc.id, hc.client_id, hc.building_id,
    COALESCE(ev.visitor_id, wv.visitor_id),
    hc.expected_visitor_id, hc.walk_in_visit_id, NULL::uuid,
    hc.created_by_user_id, hc.created_at, hc.notes
  FROM host_confirmations hc
  LEFT JOIN expected_visitors ev ON ev.id = hc.expected_visitor_id
  LEFT JOIN walk_in_visits wv ON wv.id = hc.walk_in_visit_id

  UNION ALL

  SELECT
    CASE hc.status
      WHEN 'CONFIRMED' THEN 'HOST_CONFIRMATION_CONFIRMED'
      ELSE 'HOST_CONFIRMATION_REJECTED'
    END,
    'HOST_CONFIRMATION',
    hc.id, hc.client_id, hc.building_id,
    COALESCE(ev.visitor_id, wv.visitor_id),
    hc.expected_visitor_id, hc.walk_in_visit_id, NULL::uuid,
    hc.confirmed_by_user_id, hc.confirmed_at,
    CASE
      WHEN hc.status = 'REJECTED' THEN hc.rejection_reason
      ELSE hc.notes
    END
  FROM host_confirmations hc
  LEFT JOIN expected_visitors ev ON ev.id = hc.expected_visitor_id
  LEFT JOIN walk_in_visits wv ON wv.id = hc.walk_in_visit_id
  WHERE hc.status IN ('CONFIRMED', 'REJECTED')

  UNION ALL

  SELECT
    'VISIT_CHECKED_IN', 'VISIT_CHECK_IN',
    ci.id, ci.client_id, ci.building_id, ci.visitor_id,
    ci.expected_visitor_id, ci.walk_in_visit_id, ci.id,
    ci.checked_in_by_user_id, ci.checked_in_at, ci.entry_notes
  FROM visit_check_ins ci

  UNION ALL

  SELECT
    'VISIT_CHECKED_OUT', 'VISIT_CHECK_IN',
    ci.id, ci.client_id, ci.building_id, ci.visitor_id,
    ci.expected_visitor_id, ci.walk_in_visit_id, ci.id,
    ci.checked_out_by_user_id, ci.checked_out_at, ci.exit_notes
  FROM visit_check_ins ci
  WHERE ci.status = 'CHECKED_OUT'

  UNION ALL

  SELECT
    'VISITOR_PASS_ISSUED', 'VISITOR_PASS',
    vp.id, vp.client_id, vp.building_id, ci.visitor_id,
    ci.expected_visitor_id, ci.walk_in_visit_id, vp.visit_check_in_id,
    vp.issued_by_user_id, vp.issued_at, NULL::text
  FROM visitor_passes vp
  JOIN visit_check_ins ci ON ci.id = vp.visit_check_in_id

  UNION ALL

  SELECT
    'VISITOR_PASS_RETURNED', 'VISITOR_PASS',
    vp.id, vp.client_id, vp.building_id, ci.visitor_id,
    ci.expected_visitor_id, ci.walk_in_visit_id, vp.visit_check_in_id,
    vp.returned_by_user_id, vp.returned_at, NULL::text
  FROM visitor_passes vp
  JOIN visit_check_ins ci ON ci.id = vp.visit_check_in_id
  WHERE vp.status = 'RETURNED'

  UNION ALL

  SELECT
    'VISITOR_PASS_CANCELLED', 'VISITOR_PASS',
    vp.id, vp.client_id, vp.building_id, ci.visitor_id,
    ci.expected_visitor_id, ci.walk_in_visit_id, vp.visit_check_in_id,
    vp.cancelled_by_user_id, vp.cancelled_at, NULL::text
  FROM visitor_passes vp
  JOIN visit_check_ins ci ON ci.id = vp.visit_check_in_id
  WHERE vp.status = 'CANCELLED'

  UNION ALL

  SELECT
    'CONTRACTOR_VISITOR_REGISTERED', 'CONTRACTOR_VISITOR',
    cv.id, cv.client_id, cv.building_id, cv.visitor_id,
    cv.expected_visitor_id, cv.walk_in_visit_id, NULL::uuid,
    cv.created_by_user_id, cv.created_at, cv.notes
  FROM contractor_visitors cv

  UNION ALL

  SELECT
    'DELIVERY_COURIER_ARRIVED', 'DELIVERY_COURIER',
    dc.id, dc.client_id, dc.building_id, dc.visitor_id,
    dc.expected_visitor_id, dc.walk_in_visit_id, NULL::uuid,
    dc.created_by_user_id, dc.arrived_at, dc.notes
  FROM delivery_couriers dc

  UNION ALL

  SELECT
    CASE dc.status
      WHEN 'RECEIVED' THEN 'DELIVERY_COURIER_RECEIVED'
      WHEN 'REJECTED' THEN 'DELIVERY_COURIER_REJECTED'
      ELSE 'DELIVERY_COURIER_CANCELLED'
    END,
    'DELIVERY_COURIER',
    dc.id, dc.client_id, dc.building_id, dc.visitor_id,
    dc.expected_visitor_id, dc.walk_in_visit_id, NULL::uuid,
    dc.status_updated_by_user_id, dc.status_updated_at, dc.notes
  FROM delivery_couriers dc
  WHERE dc.status IN ('RECEIVED', 'REJECTED', 'CANCELLED')
)
`;

type FrontDeskLogRow = {
  id: string;
  activity_type: FrontDeskActivityType;
  source_type: FrontDeskSourceType;
  source_id: string;
  client_id: string;
  building_id: string;
  visitor_id: string | null;
  expected_visitor_id: string | null;
  walk_in_visit_id: string | null;
  visit_check_in_id: string | null;
  actor_user_id: string;
  occurred_at: Date;
  notes: string | null;
};

const EVENT_SELECT = `
  activity_type || ':' || source_id::text AS id,
  activity_type, source_type, source_id,
  client_id, building_id, visitor_id,
  expected_visitor_id, walk_in_visit_id, visit_check_in_id,
  actor_user_id, occurred_at, notes
`;

function mapRow(row: FrontDeskLogRow): FrontDeskLogRecord {
  return {
    id: row.id,
    activityType: row.activity_type,
    sourceType: row.source_type,
    sourceId: row.source_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    visitorId: row.visitor_id,
    expectedVisitorId: row.expected_visitor_id,
    walkInVisitId: row.walk_in_visit_id,
    visitCheckInId: row.visit_check_in_id,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at,
    notes: row.notes,
  };
}

export async function findByIdentity(
  identity: FrontDeskLogIdentity,
): Promise<FrontDeskLogRecord | null> {
  const result = await getPool().query<FrontDeskLogRow>(
    `${FRONT_DESK_EVENTS_CTE}
     SELECT ${EVENT_SELECT}
     FROM front_desk_events
     WHERE activity_type = $1 AND source_id = $2
     LIMIT 1`,
    [identity.activityType, identity.sourceId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filters: FrontDeskLogFilters = {},
): Promise<FrontDeskLogRecord[]> {
  if (buildingIds.length === 0) return [];

  const conditions = ['building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];
  const add = (condition: string, value: unknown): void => {
    values.push(value);
    conditions.push(condition.replace('?', `$${values.length}`));
  };

  if (filters.visitorId) add('visitor_id = ?', filters.visitorId);
  if (filters.activityType) add('activity_type = ?', filters.activityType);
  if (filters.occurredFrom) add('occurred_at >= ?', filters.occurredFrom);
  if (filters.occurredTo) add('occurred_at <= ?', filters.occurredTo);

  const result = await getPool().query<FrontDeskLogRow>(
    `${FRONT_DESK_EVENTS_CTE}
     SELECT ${EVENT_SELECT}
     FROM front_desk_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY occurred_at ASC, activity_type ASC, source_id ASC`,
    values,
  );
  return result.rows.map(mapRow);
}

export const frontDeskLogRepository = {
  findByIdentity,
  listByBuildingIds,
};

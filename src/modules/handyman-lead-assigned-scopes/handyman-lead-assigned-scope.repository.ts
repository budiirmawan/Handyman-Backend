import type { QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanLeadAssignedScopeCandidate,
  HandymanLeadCurrentScope,
  HandymanLeadLocationSource,
  HandymanLeadPermitReadinessRecord,
  HandymanLeadSchedulingReadinessRecord,
  HandymanLeadUnitAccessReadinessRecord,
  HandymanLeadWorkItemRecord,
} from './handyman-lead-assigned-scope.types';

type Row = QueryResultRow;

/**
 * Resolve only the live CR-HM-04 actor chain. The lead row is the highest
 * lead_seq for the crew; assignment, provider, crew, membership, and worker
 * context must all still be ACTIVE. No assignment/Lead snapshot is trusted.
 */
const CURRENT_LEAD_CHAIN_FROM = `
  FROM handyman_execution_scope_assignments a
  JOIN handyman_execution_scopes s
    ON s.id = a.execution_scope_id
   AND s.client_id = a.client_id
  JOIN handyman_provider_contexts pc
    ON pc.id = a.handyman_provider_context_id
   AND pc.client_id = a.client_id
   AND pc.status = 'ACTIVE'
  JOIN handyman_work_crews c
    ON c.id = a.handyman_crew_id
   AND c.client_id = a.client_id
   AND c.handyman_provider_context_id = pc.id
   AND c.status = 'ACTIVE'
  JOIN LATERAL (
    SELECT l.handyman_crew_membership_id
      FROM handyman_crew_leads l
     WHERE l.handyman_crew_id = c.id
     ORDER BY l.lead_seq DESC
     LIMIT 1
  ) current_lead ON TRUE
  JOIN handyman_crew_memberships m
    ON m.id = current_lead.handyman_crew_membership_id
   AND m.client_id = a.client_id
   AND m.handyman_crew_id = c.id
   AND m.status = 'ACTIVE'
  JOIN handyman_worker_contexts wc
    ON wc.id = m.handyman_worker_context_id
   AND wc.client_id = a.client_id
   AND wc.handyman_provider_context_id = pc.id
   AND wc.status = 'ACTIVE'
  JOIN workforce_profiles wp
    ON wp.id = wc.workforce_profile_id
`;

const CURRENT_LEAD_CHAIN_WHERE = `
  a.status = 'ACTIVE'
  AND s.status = 'AUTHORIZED'
  AND wp.user_id = $1
`;

const FIELD_SCOPE_JOINS = `
  JOIN handyman_service_requests r
    ON r.id = s.handyman_request_id
   AND r.client_id = s.client_id
  JOIN service_catalog svc
    ON svc.id = r.service_catalog_id
   AND svc.client_id = s.client_id
  JOIN buildings b ON b.id = s.building_id
  JOIN properties prop
    ON prop.id = b.property_id
   AND prop.client_id = s.client_id
  LEFT JOIN floors f
    ON f.id = s.floor_id
   AND f.building_id = b.id
  LEFT JOIN areas ar
    ON ar.id = s.area_id
   AND ar.floor_id = f.id
  LEFT JOIN rooms rm
    ON rm.id = s.room_id
   AND rm.area_id = ar.id
  LEFT JOIN spaces sp
    ON sp.id = s.space_id
   AND sp.room_id = rm.id
`;

const FIELD_SCOPE_SELECT = `
  s.id AS "executionScopeId",
  s.client_id AS "clientId",
  a.id AS "assignmentId",
  a.assigned_at AS "assignedAt",
  s.handyman_request_id AS "handymanRequestId",
  s.approved_quotation_version_id AS "approvedQuotationVersionId",
  svc.name AS "serviceLabel",
  b.code AS "buildingCode",
  f.level_number AS "floorLevelNumber",
  ar.code AS "areaCode",
  rm.code AS "roomCode",
  sp.code AS "spaceCode"
`;

const CARD_ROW_SELECT = `
  ${FIELD_SCOPE_SELECT},
  sr.preferred_window_start AS "preferredWindowStart",
  sr.preferred_window_end AS "preferredWindowEnd",
  sr.timezone AS "preferredWindowTimezone"
`;

async function listCurrentLeadClientIds(userId: string): Promise<string[]> {
  const result = await getPool().query<Row>(
    `SELECT DISTINCT a.client_id AS "clientId"
       ${CURRENT_LEAD_CHAIN_FROM}
      WHERE ${CURRENT_LEAD_CHAIN_WHERE}
      ORDER BY a.client_id`,
    [userId],
  );
  return result.rows.map((row) => row.clientId as string);
}

async function listCurrentLeadAssignedScopeCards(
  userId: string,
  accessibleClientIds: string[],
  pageSize: number,
  offset: number,
): Promise<{ rows: HandymanLeadAssignedScopeCandidate[]; total: number }> {
  if (accessibleClientIds.length === 0) return { rows: [], total: 0 };

  type CardRow = Row & {
    total: number;
    executionScopeId: string | null;
    clientId: string | null;
    assignmentId: string | null;
    assignedAt: Date | null;
    handymanRequestId: string | null;
    approvedQuotationVersionId: string | null;
    serviceLabel: string | null;
    buildingCode: string | null;
    floorLevelNumber: number | null;
    areaCode: string | null;
    roomCode: string | null;
    spaceCode: string | null;
    preferredWindowStart: Date | null;
    preferredWindowEnd: Date | null;
    preferredWindowTimezone: string | null;
  };

  // The count and page share one materialized read of current assignments.
  // LEFT JOIN preserves the count even when the requested page is empty.
  const result = await getPool().query<CardRow>(
    `WITH visible AS MATERIALIZED (
       SELECT ${CARD_ROW_SELECT}
         ${CURRENT_LEAD_CHAIN_FROM}
         ${FIELD_SCOPE_JOINS}
         LEFT JOIN handyman_scheduling_readiness sr
           ON sr.handyman_request_id = s.handyman_request_id
          AND sr.client_id = s.client_id
          AND sr.status = 'ACTIVE'
        WHERE ${CURRENT_LEAD_CHAIN_WHERE}
          AND a.client_id = ANY($2::uuid[])
     ),
     page AS MATERIALIZED (
       SELECT * FROM visible
        ORDER BY "assignedAt" DESC, "executionScopeId" ASC
        LIMIT $3 OFFSET $4
     )
     SELECT totals.total, page.*
       FROM (SELECT COUNT(*)::int AS total FROM visible) totals
       LEFT JOIN page ON TRUE
      ORDER BY page."assignedAt" DESC NULLS LAST,
               page."executionScopeId" ASC NULLS LAST`,
    [userId, accessibleClientIds, pageSize, offset],
  );

  const total = result.rows[0]?.total ?? 0;
  const rows = result.rows
    .filter((row) => row.executionScopeId !== null)
    .map((row) => ({
      executionScopeId: row.executionScopeId as string,
      clientId: row.clientId as string,
      assignmentId: row.assignmentId as string,
      assignedAt: row.assignedAt as Date,
      handymanRequestId: row.handymanRequestId as string,
      approvedQuotationVersionId: row.approvedQuotationVersionId as string,
      serviceLabel: row.serviceLabel as string,
      location: {
        buildingCode: row.buildingCode as string,
        floorLevelNumber: row.floorLevelNumber,
        areaCode: row.areaCode,
        roomCode: row.roomCode,
        spaceCode: row.spaceCode,
      },
      preferredWindowStart: row.preferredWindowStart,
      preferredWindowEnd: row.preferredWindowEnd,
      preferredWindowTimezone: row.preferredWindowTimezone,
    }));
  return { rows, total };
}

async function findCurrentLeadAssignedScope(
  userId: string,
  executionScopeId: string,
): Promise<HandymanLeadCurrentScope | null> {
  const result = await getPool().query<Row>(
    `SELECT ${FIELD_SCOPE_SELECT}
       ${CURRENT_LEAD_CHAIN_FROM}
       ${FIELD_SCOPE_JOINS}
      WHERE ${CURRENT_LEAD_CHAIN_WHERE}
        AND s.id = $2`,
    [userId, executionScopeId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    executionScopeId: row.executionScopeId as string,
    clientId: row.clientId as string,
    assignmentId: row.assignmentId as string,
    assignedAt: row.assignedAt as Date,
    handymanRequestId: row.handymanRequestId as string,
    approvedQuotationVersionId: row.approvedQuotationVersionId as string,
    serviceLabel: row.serviceLabel as string,
    location: {
      buildingCode: row.buildingCode as string,
      floorLevelNumber: row.floorLevelNumber as number | null,
      areaCode: row.areaCode as string | null,
      roomCode: row.roomCode as string | null,
      spaceCode: row.spaceCode as string | null,
    },
  };
}

async function listApprovedWorkItems(
  executionScopeId: string,
): Promise<HandymanLeadWorkItemRecord[]> {
  const result = await getPool().query<Row>(
    `SELECT ql.line_type AS "lineType",
            ql.quantity::double precision AS quantity,
            u.name AS "unitLabel"
       FROM handyman_execution_scopes s
       JOIN handyman_quotation_lines ql
         ON ql.quotation_version_id = s.approved_quotation_version_id
       JOIN units_of_measure u
         ON u.id = ql.uom_id
        AND u.client_id = s.client_id
      WHERE s.id = $1
      ORDER BY ql.created_at ASC, ql.id ASC`,
    [executionScopeId],
  );
  return result.rows.map((row) => ({
    lineType: row.lineType as 'LABOR' | 'MATERIAL',
    quantity: Number(row.quantity),
    unitLabel: row.unitLabel as string,
  }));
}

async function findCurrentSchedulingReadiness(
  executionScopeId: string,
): Promise<HandymanLeadSchedulingReadinessRecord | null> {
  const result = await getPool().query<Row>(
    `SELECT r.status,
            r.preferred_window_start AS "preferredWindowStart",
            r.preferred_window_end AS "preferredWindowEnd",
            r.timezone
       FROM handyman_execution_scopes s
       JOIN handyman_scheduling_readiness r
         ON r.handyman_request_id = s.handyman_request_id
        AND r.client_id = s.client_id
        AND r.status = 'ACTIVE'
      WHERE s.id = $1`,
    [executionScopeId],
  );
  const row = result.rows[0];
  return row
    ? {
      status: row.status as 'ACTIVE',
      preferredWindowStart: row.preferredWindowStart as Date,
      preferredWindowEnd: row.preferredWindowEnd as Date,
      timezone: row.timezone as string,
    }
    : null;
}

async function findCurrentUnitAccessReadiness(
  executionScopeId: string,
): Promise<HandymanLeadUnitAccessReadinessRecord | null> {
  const result = await getPool().query<Row>(
    `SELECT r.status,
            r.access_window_start AS "accessWindowStart",
            r.access_window_end AS "accessWindowEnd"
       FROM handyman_execution_scopes s
       JOIN handyman_unit_access_readiness r
         ON r.handyman_request_id = s.handyman_request_id
        AND r.client_id = s.client_id
        AND r.status = 'ACTIVE'
      WHERE s.id = $1`,
    [executionScopeId],
  );
  const row = result.rows[0];
  return row
    ? {
      status: row.status as 'ACTIVE',
      accessWindowStart: row.accessWindowStart as Date,
      accessWindowEnd: row.accessWindowEnd as Date,
    }
    : null;
}

async function listCurrentPermitReadiness(
  executionScopeId: string,
): Promise<HandymanLeadPermitReadinessRecord[]> {
  const result = await getPool().query<Row>(
    `SELECT r.permit_type AS "permitType",
            r.status,
            r.valid_from AS "validFrom",
            r.valid_until AS "validUntil"
       FROM handyman_execution_scopes s
       JOIN handyman_permit_readiness r
         ON r.handyman_request_id = s.handyman_request_id
        AND r.client_id = s.client_id
        AND r.status = 'ACTIVE'
      WHERE s.id = $1
      ORDER BY r.valid_from ASC, r.id ASC`,
    [executionScopeId],
  );
  return result.rows.map((row) => ({
    permitType: row.permitType as 'UNIT' | 'BUILDING_COMMON_AREA',
    status: row.status as 'ACTIVE',
    validFrom: row.validFrom as Date,
    validUntil: row.validUntil as Date,
  }));
}

export const handymanLeadAssignedScopeRepository = {
  listCurrentLeadClientIds,
  listCurrentLeadAssignedScopeCards,
  findCurrentLeadAssignedScope,
  listApprovedWorkItems,
  findCurrentSchedulingReadiness,
  findCurrentUnitAccessReadiness,
  listCurrentPermitReadiness,
};

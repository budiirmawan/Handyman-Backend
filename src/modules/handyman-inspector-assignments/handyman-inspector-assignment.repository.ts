import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanInspectorAssignmentRecord,
  NewHandymanInspectorAssignment,
} from './handyman-inspector-assignment.types';

type Row = QueryResultRow;

const SELECT = `
  SELECT id, client_id, handyman_request_id, visit_appointment_id,
         inspector_user_id, status, assigned_by_user_id, assigned_at,
         supersedes_assignment_id, reassignment_reason, version,
         created_at, updated_at
    FROM handyman_inspector_assignments`;

function map(row: Row): HandymanInspectorAssignmentRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    visitAppointmentId: row.visit_appointment_id,
    inspectorUserId: row.inspector_user_id,
    status: row.status,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: row.assigned_at,
    supersedesAssignmentId: row.supersedes_assignment_id,
    reassignmentReason: row.reassignment_reason,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findVisit(
  executor: Pick<PoolClient, 'query'> = getPool(),
  visitId: string,
): Promise<{
  id: string;
  clientId: string;
  handymanRequestId: string;
  buildingId: string;
  tenantCompanyId: string;
  kind: string;
  state: string;
  resourceType: string;
  startAt: Date;
  endAt: Date;
} | null> {
  const res = await executor.query(
    `SELECT id, client_id, handyman_request_id, building_id, tenant_company_id,
            kind, state, resource_type, start_at, end_at
       FROM handyman_visit_appointments WHERE id = $1`,
    [visitId],
  );
  return res.rows[0]
    ? {
        id: res.rows[0].id,
        clientId: res.rows[0].client_id,
        handymanRequestId: res.rows[0].handyman_request_id,
        buildingId: res.rows[0].building_id,
        tenantCompanyId: res.rows[0].tenant_company_id,
        kind: res.rows[0].kind,
        state: res.rows[0].state,
        resourceType: res.rows[0].resource_type,
        startAt: res.rows[0].start_at,
        endAt: res.rows[0].end_at,
      }
    : null;
}

async function lockVisit(
  executor: Pick<PoolClient, 'query'>,
  visitId: string,
) {
  const res = await executor.query(
    `SELECT id, client_id, handyman_request_id, building_id, tenant_company_id,
            kind, state, resource_type, start_at, end_at
       FROM handyman_visit_appointments WHERE id = $1 FOR UPDATE`,
    [visitId],
  );
  return res.rows[0]
    ? {
        id: res.rows[0].id,
        clientId: res.rows[0].client_id,
        handymanRequestId: res.rows[0].handyman_request_id,
        buildingId: res.rows[0].building_id,
        tenantCompanyId: res.rows[0].tenant_company_id,
        kind: res.rows[0].kind,
        state: res.rows[0].state,
        resourceType: res.rows[0].resource_type,
        startAt: res.rows[0].start_at,
        endAt: res.rows[0].end_at,
      }
    : null;
}

async function lockActiveByVisit(
  executor: Pick<PoolClient, 'query'>,
  visitId: string,
): Promise<HandymanInspectorAssignmentRecord | null> {
  const res = await executor.query(
    `${SELECT} WHERE visit_appointment_id = $1 AND status = 'ACTIVE' FOR UPDATE`,
    [visitId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function findActiveByVisit(
  executor: Pick<PoolClient, 'query'> = getPool(),
  visitId: string,
): Promise<HandymanInspectorAssignmentRecord | null> {
  const res = await executor.query(
    `${SELECT} WHERE visit_appointment_id = $1 AND status = 'ACTIVE'`,
    [visitId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function insert(
  executor: Pick<PoolClient, 'query'>,
  record: NewHandymanInspectorAssignment,
): Promise<HandymanInspectorAssignmentRecord> {
  const res = await executor.query(
    `INSERT INTO handyman_inspector_assignments (
       id, client_id, handyman_request_id, visit_appointment_id,
       inspector_user_id, status, assigned_by_user_id,
       supersedes_assignment_id, reassignment_reason
     ) VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7, $8)
     RETURNING id, client_id, handyman_request_id, visit_appointment_id,
               inspector_user_id, status, assigned_by_user_id, assigned_at,
               supersedes_assignment_id, reassignment_reason, version,
               created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.handymanRequestId,
      record.visitAppointmentId,
      record.inspectorUserId,
      record.assignedByUserId,
      record.supersedesAssignmentId,
      record.reassignmentReason ?? null,
    ],
  );
  return map(res.rows[0]);
}

async function supersede(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  status: 'SUPERSEDED' | 'REVOKED',
  reason: string,
  expectedVersion: number,
): Promise<HandymanInspectorAssignmentRecord | null> {
  const res = await executor.query(
    `UPDATE handyman_inspector_assignments
        SET status = $2, reassignment_reason = $3,
            version = version + 1, updated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE' AND version = $4
      RETURNING id, client_id, handyman_request_id, visit_appointment_id,
                inspector_user_id, status, assigned_by_user_id, assigned_at,
                supersedes_assignment_id, reassignment_reason, version,
                created_at, updated_at`,
    [id, status, reason, expectedVersion],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function listHistoryByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  requestId: string,
): Promise<HandymanInspectorAssignmentRecord[]> {
  const res = await executor.query(
    `${SELECT} WHERE client_id = $1 AND handyman_request_id = $2
       ORDER BY assigned_at DESC, id DESC`,
    [clientId, requestId],
  );
  return res.rows.map(map);
}

async function findActiveByInspector(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  inspectorUserId: string,
  options?: { startAt?: Date; endAt?: Date; excludeVisitId?: string },
): Promise<HandymanInspectorAssignmentRecord[]> {
  const params: unknown[] = [clientId, inspectorUserId];
  let sql = `${SELECT}
      WHERE client_id = $1 AND inspector_user_id = $2 AND status = 'ACTIVE'`;
  if (options?.excludeVisitId) {
    params.push(options.excludeVisitId);
    sql += ` AND visit_appointment_id <> $3`;
  }
  sql += ` ORDER BY assigned_at DESC`;
  const res = await executor.query(sql, params);
  return res.rows.map(map);
}

async function findByIdAndVisit(
  executor: Pick<PoolClient, 'query'> = getPool(),
  assignmentId: string,
  visitId: string,
): Promise<HandymanInspectorAssignmentRecord | null> {
  const res = await executor.query(
    `${SELECT} WHERE id = $1 AND visit_appointment_id = $2`,
    [assignmentId, visitId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function lockByIdAndVisit(
  executor: Pick<PoolClient, 'query'>,
  assignmentId: string,
  visitId: string,
): Promise<HandymanInspectorAssignmentRecord | null> {
  const res = await executor.query(
    `${SELECT} WHERE id = $1 AND visit_appointment_id = $2 FOR UPDATE`,
    [assignmentId, visitId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

export const handymanInspectorAssignmentRepository = {
  findVisit,
  lockVisit,
  findActiveByVisit,
  lockActiveByVisit,
  findByIdAndVisit,
  lockByIdAndVisit,
  insert,
  supersede,
  listHistoryByRequest,
  findActiveByInspector,
};

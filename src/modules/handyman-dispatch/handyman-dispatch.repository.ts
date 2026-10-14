import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanDispatchReleaseRecord,
  HandymanDispatchReleaseStatus,
} from './handyman-dispatch.types';

type Row = QueryResultRow;

const SELECT = `
  SELECT id, client_id, execution_scope_id, assignment_id, appointment_id,
         status, released_by_user_id, released_at,
         cancelled_by_user_id, cancelled_at, cancel_reason,
         readiness_snapshot, version, created_at, updated_at
    FROM handyman_dispatch_releases`;

function map(row: Row): HandymanDispatchReleaseRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    assignmentId: row.assignment_id,
    appointmentId: row.appointment_id,
    status: row.status as HandymanDispatchReleaseStatus,
    releasedByUserId: row.released_by_user_id,
    releasedAt: row.released_at,
    cancelledByUserId: row.cancelled_by_user_id,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    readinessSnapshot: row.readiness_snapshot as Record<string, unknown>,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findActiveByScope(
  executor: Pick<PoolClient, 'query'> = getPool(),
  executionScopeId: string,
): Promise<HandymanDispatchReleaseRecord | null> {
  const res = await executor.query(
    `${SELECT} WHERE execution_scope_id = $1 AND status IN ('RELEASED','IN_PROGRESS')`,
    [executionScopeId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function lockActiveByScope(
  executor: Pick<PoolClient, 'query'>,
  executionScopeId: string,
): Promise<HandymanDispatchReleaseRecord | null> {
  const res = await executor.query(
    `${SELECT} WHERE execution_scope_id = $1 AND status IN ('RELEASED','IN_PROGRESS') FOR UPDATE`,
    [executionScopeId],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function insert(
  executor: Pick<PoolClient, 'query'>,
  record: {
    clientId: string;
    executionScopeId: string;
    assignmentId: string;
    appointmentId: string | null;
    releasedByUserId: string;
    readinessSnapshot: Record<string, unknown>;
  },
): Promise<HandymanDispatchReleaseRecord> {
  const res = await executor.query(
    `INSERT INTO handyman_dispatch_releases (
       id, client_id, execution_scope_id, assignment_id, appointment_id,
       status, released_by_user_id, readiness_snapshot
     ) VALUES ($1,$2,$3,$4,$5,'RELEASED',$6,$7)
     RETURNING id, client_id, execution_scope_id, assignment_id, appointment_id,
               status, released_by_user_id, released_at,
               cancelled_by_user_id, cancelled_at, cancel_reason,
               readiness_snapshot, version, created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.executionScopeId,
      record.assignmentId,
      record.appointmentId,
      record.releasedByUserId,
      record.readinessSnapshot,
    ],
  );
  return map(res.rows[0]);
}

async function markInProgress(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanDispatchReleaseRecord | null> {
  const res = await executor.query(
    `UPDATE handyman_dispatch_releases
        SET status = 'IN_PROGRESS', version = version + 1, updated_at = NOW()
      WHERE id = $1 AND status = 'RELEASED'
      RETURNING id, client_id, execution_scope_id, assignment_id, appointment_id,
                status, released_by_user_id, released_at,
                cancelled_by_user_id, cancelled_at, cancel_reason,
                readiness_snapshot, version, created_at, updated_at`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function markCompleted(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanDispatchReleaseRecord | null> {
  const res = await executor.query(
    `UPDATE handyman_dispatch_releases
        SET status = 'COMPLETED', version = version + 1, updated_at = NOW()
      WHERE id = $1 AND status = 'IN_PROGRESS'
      RETURNING id, client_id, execution_scope_id, assignment_id, appointment_id,
                status, released_by_user_id, released_at,
                cancelled_by_user_id, cancelled_at, cancel_reason,
                readiness_snapshot, version, created_at, updated_at`,
    [id],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

async function cancel(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  actorUserId: string,
  reason: string,
): Promise<HandymanDispatchReleaseRecord | null> {
  const res = await executor.query(
    `UPDATE handyman_dispatch_releases
        SET status = 'CANCELLED', version = version + 1, updated_at = NOW(),
            cancelled_by_user_id = $2, cancelled_at = NOW(), cancel_reason = $3
      WHERE id = $1 AND status IN ('RELEASED','IN_PROGRESS')
      RETURNING id, client_id, execution_scope_id, assignment_id, appointment_id,
                status, released_by_user_id, released_at,
                cancelled_by_user_id, cancelled_at, cancel_reason,
                readiness_snapshot, version, created_at, updated_at`,
    [id, actorUserId, reason],
  );
  return res.rows[0] ? map(res.rows[0]) : null;
}

/**
 * Supersede RELEASED releases tied to a superseded assignment. Used by
 * crew reassignment before a work session starts (IN_PROGRESS rows are
 * forbidden by the trigger/upstream guard). Returns the number of rows
 * updated so callers can audit.
 */
async function supersedeForAssignment(
  executor: Pick<PoolClient, 'query'>,
  assignmentId: string,
  actorUserId: string,
  reason: string,
): Promise<number> {
  const res = await executor.query(
    `UPDATE handyman_dispatch_releases
        SET status = 'SUPERSEDED', version = version + 1, updated_at = NOW(),
            cancelled_by_user_id = $2, cancelled_at = NOW(), cancel_reason = $3
      WHERE assignment_id = $1 AND status = 'RELEASED'`,
    [assignmentId, actorUserId, reason],
  );
  return res.rowCount ?? 0;
}

export const handymanDispatchRepository = {
  findActiveByScope,
  lockActiveByScope,
  insert,
  markInProgress,
  markCompleted,
  cancel,
  supersedeForAssignment,
};

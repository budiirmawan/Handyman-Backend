import { getPool } from '../../database';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  HandymanSchedulingReadinessRecord,
  NewHandymanSchedulingReadinessRecord,
} from './handyman-scheduling.types';

/**
 * CR-HM-05 PART 01 — persistence for Handyman Scheduling Readiness.
 * Rows are inserted ACTIVE or deactivated on supersede; rows are NEVER
 * hard-deleted (FROZEN F8 history preservation).
 */

const SELECT = `
  id, client_id AS "clientId",
  handyman_request_id AS "handymanRequestId",
  timezone,
  preferred_window_start AS "preferredWindowStart",
  preferred_window_end AS "preferredWindowEnd",
  status,
  supersedes_readiness_id AS "supersedesReadinessId",
  change_reason AS "changeReason",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

type Executor = Pick<PoolClient, 'query'>;

async function insert(
  executor: Executor,
  input: NewHandymanSchedulingReadinessRecord,
): Promise<HandymanSchedulingReadinessRecord> {
  const result = await executor.query<HandymanSchedulingReadinessRecord>(
    `INSERT INTO handyman_scheduling_readiness (
       id, client_id, handyman_request_id, timezone,
       preferred_window_start, preferred_window_end,
       supersedes_readiness_id, change_reason,
       created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanRequestId,
      input.timezone,
      input.preferredWindowStart,
      input.preferredWindowEnd,
      input.supersedesReadinessId,
      input.changeReason,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  executor: Executor = getPool(),
  id: string,
): Promise<HandymanSchedulingReadinessRecord | null> {
  const result = await executor.query<HandymanSchedulingReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_scheduling_readiness WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Transactional row lock for supersede. */
async function lockById(
  executor: Executor,
  id: string,
): Promise<HandymanSchedulingReadinessRecord | null> {
  const result = await executor.query<HandymanSchedulingReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_scheduling_readiness
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Exactly one ACTIVE row per request (partial UNIQUE index guard). */
async function findActiveByRequest(
  executor: Executor = getPool(),
  handymanRequestId: string,
): Promise<HandymanSchedulingReadinessRecord | null> {
  const result = await executor.query<HandymanSchedulingReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_scheduling_readiness
     WHERE handyman_request_id = $1 AND status = 'ACTIVE'`,
    [handymanRequestId],
  );
  return result.rows[0] ?? null;
}

/** Full preserved history, oldest first. */
async function listByRequest(
  executor: Executor = getPool(),
  handymanRequestId: string,
): Promise<HandymanSchedulingReadinessRecord[]> {
  const result = await executor.query<HandymanSchedulingReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_scheduling_readiness
     WHERE handyman_request_id = $1
     ORDER BY created_at ASC, id ASC`,
    [handymanRequestId],
  );
  return result.rows;
}

/** Supersede transition: ACTIVE → INACTIVE (history-fact update). */
async function setStatus(
  executor: Executor,
  id: string,
  status: 'ACTIVE' | 'INACTIVE',
): Promise<HandymanSchedulingReadinessRecord | null> {
  const result = await executor.query<HandymanSchedulingReadinessRecord>(
    `UPDATE handyman_scheduling_readiness
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${SELECT}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

export const handymanSchedulingReadinessRepository = {
  insert,
  findById,
  lockById,
  findActiveByRequest,
  listByRequest,
  setStatus,
};

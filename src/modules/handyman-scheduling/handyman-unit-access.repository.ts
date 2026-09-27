import { getPool } from '../../database';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  HandymanUnitAccessReadinessRecord,
  NewHandymanUnitAccessReadinessRecord,
} from './handyman-unit-access.types';

/**
 * CR-HM-05 PART 02 — persistence for Handyman Unit Access Readiness.
 * Rows are inserted ACTIVE or deactivated on supersede; rows are NEVER
 * hard-deleted (FROZEN F8 history preservation).
 */

const SELECT = `
  id, client_id AS "clientId",
  handyman_request_id AS "handymanRequestId",
  building_id AS "buildingId",
  floor_id AS "floorId",
  area_id AS "areaId",
  room_id AS "roomId",
  space_id AS "spaceId",
  access_window_start AS "accessWindowStart",
  access_window_end AS "accessWindowEnd",
  authorization_note AS "authorizationNote",
  status,
  authorized_by_user_id AS "authorizedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

type Executor = Pick<PoolClient, 'query'>;

async function insert(
  executor: Executor,
  input: NewHandymanUnitAccessReadinessRecord,
): Promise<HandymanUnitAccessReadinessRecord> {
  const result = await executor.query<HandymanUnitAccessReadinessRecord>(
    `INSERT INTO handyman_unit_access_readiness (
       id, client_id, handyman_request_id,
       building_id, floor_id, area_id, room_id, space_id,
       access_window_start, access_window_end, authorization_note,
       authorized_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.handymanRequestId,
      input.buildingId,
      input.floorId,
      input.areaId,
      input.roomId,
      input.spaceId,
      input.accessWindowStart,
      input.accessWindowEnd,
      input.authorizationNote,
      input.authorizedByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  executor: Executor = getPool(),
  id: string,
): Promise<HandymanUnitAccessReadinessRecord | null> {
  const result = await executor.query<HandymanUnitAccessReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_unit_access_readiness WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Transactional row lock for supersede. */
async function lockById(
  executor: Executor,
  id: string,
): Promise<HandymanUnitAccessReadinessRecord | null> {
  const result = await executor.query<HandymanUnitAccessReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_unit_access_readiness
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Exactly one ACTIVE row per request (partial UNIQUE index guard). */
async function findActiveByRequest(
  executor: Executor = getPool(),
  handymanRequestId: string,
): Promise<HandymanUnitAccessReadinessRecord | null> {
  const result = await executor.query<HandymanUnitAccessReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_unit_access_readiness
     WHERE handyman_request_id = $1 AND status = 'ACTIVE'`,
    [handymanRequestId],
  );
  return result.rows[0] ?? null;
}

/** Full preserved history, oldest first. */
async function listByRequest(
  executor: Executor = getPool(),
  handymanRequestId: string,
): Promise<HandymanUnitAccessReadinessRecord[]> {
  const result = await executor.query<HandymanUnitAccessReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_unit_access_readiness
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
): Promise<HandymanUnitAccessReadinessRecord | null> {
  const result = await executor.query<HandymanUnitAccessReadinessRecord>(
    `UPDATE handyman_unit_access_readiness
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${SELECT}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

export const handymanUnitAccessReadinessRepository = {
  insert,
  findById,
  lockById,
  findActiveByRequest,
  listByRequest,
  setStatus,
};

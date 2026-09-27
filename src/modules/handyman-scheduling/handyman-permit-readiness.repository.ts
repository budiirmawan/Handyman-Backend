import { getPool } from '../../database';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  HandymanPermitReadinessRecord,
  NewHandymanPermitReadinessRecord,
} from './handyman-permit-readiness.types';

/**
 * CR-HM-05 PART 03 — persistence for Handyman Permit Readiness.
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
  permit_type AS "permitType",
  valid_from AS "validFrom",
  valid_until AS "validUntil",
  authorization_note AS "authorizationNote",
  status,
  authorized_by_user_id AS "authorizedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

type Executor = Pick<PoolClient, 'query'>;

async function insert(
  executor: Executor,
  input: NewHandymanPermitReadinessRecord,
): Promise<HandymanPermitReadinessRecord> {
  const result = await executor.query<HandymanPermitReadinessRecord>(
    `INSERT INTO handyman_permit_readiness (
       id, client_id, handyman_request_id,
       building_id, floor_id, area_id, room_id, space_id,
       permit_type, valid_from, valid_until, authorization_note,
       authorized_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      input.permitType,
      input.validFrom,
      input.validUntil,
      input.authorizationNote,
      input.authorizedByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  executor: Executor = getPool(),
  id: string,
): Promise<HandymanPermitReadinessRecord | null> {
  const result = await executor.query<HandymanPermitReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_permit_readiness WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Transactional row lock for supersede. */
async function lockById(
  executor: Executor,
  id: string,
): Promise<HandymanPermitReadinessRecord | null> {
  const result = await executor.query<HandymanPermitReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_permit_readiness
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Exactly one ACTIVE row per request (partial UNIQUE index guard). */
async function findActiveByRequest(
  executor: Executor = getPool(),
  handymanRequestId: string,
): Promise<HandymanPermitReadinessRecord | null> {
  const result = await executor.query<HandymanPermitReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_permit_readiness
     WHERE handyman_request_id = $1 AND status = 'ACTIVE'`,
    [handymanRequestId],
  );
  return result.rows[0] ?? null;
}

/** Full preserved history, oldest first. */
async function listByRequest(
  executor: Executor = getPool(),
  handymanRequestId: string,
): Promise<HandymanPermitReadinessRecord[]> {
  const result = await executor.query<HandymanPermitReadinessRecord>(
    `SELECT ${SELECT} FROM handyman_permit_readiness
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
): Promise<HandymanPermitReadinessRecord | null> {
  const result = await executor.query<HandymanPermitReadinessRecord>(
    `UPDATE handyman_permit_readiness
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${SELECT}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

export const handymanPermitReadinessRepository = {
  insert,
  findById,
  lockById,
  findActiveByRequest,
  listByRequest,
  setStatus,
};

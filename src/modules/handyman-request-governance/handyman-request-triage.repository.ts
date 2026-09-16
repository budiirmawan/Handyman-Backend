import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanRequestTriageRecord,
  HandymanTriagePath,
} from './handyman-request-governance.types';

/**
 * CR-HM-BE-03 RUN 1 — Triage history persistence.
 *
 * Append-only: rows are created ACTIVE and may move once to SUPERSEDED
 * through the guarded transition below. The one-ACTIVE-per-request rule is
 * structurally enforced by the partial unique index
 * `handyman_request_triages_one_active_per_request` (migration 0350); the
 * service translates its violation into the governed 409.
 */

const TRIAGE_SELECT = `
  id,
  request_id AS "requestId",
  client_id AS "clientId",
  building_id AS "buildingId",
  path,
  notes,
  status,
  triaged_by_user_id AS "triagedByUserId",
  triaged_at AS "triagedAt",
  superseded_at AS "supersededAt",
  superseded_by_user_id AS "supersededByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: {
    requestId: string;
    clientId: string;
    buildingId: string;
    path: HandymanTriagePath;
    notes: string | null;
    triagedByUserId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestTriageRecord> {
  const result = await executor.query<HandymanRequestTriageRecord>(
    `INSERT INTO handyman_request_triages
       (id, request_id, client_id, building_id, path, notes, triaged_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${TRIAGE_SELECT}`,
    [
      randomUUID(),
      input.requestId,
      input.clientId,
      input.buildingId,
      input.path,
      input.notes,
      input.triagedByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestTriageRecord | null> {
  const result = await executor.query<HandymanRequestTriageRecord>(
    `SELECT ${TRIAGE_SELECT} FROM handyman_request_triages WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveByRequest(
  requestId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestTriageRecord | null> {
  const result = await executor.query<HandymanRequestTriageRecord>(
    `SELECT ${TRIAGE_SELECT}
     FROM handyman_request_triages
     WHERE request_id = $1 AND status = 'ACTIVE'`,
    [requestId],
  );
  return result.rows[0] ?? null;
}

async function listByRequest(
  requestId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestTriageRecord[]> {
  const result = await executor.query<HandymanRequestTriageRecord>(
    `SELECT ${TRIAGE_SELECT}
     FROM handyman_request_triages
     WHERE request_id = $1
     ORDER BY triaged_at ASC, id ASC`,
    [requestId],
  );
  return result.rows;
}

/**
 * Guarded supersede: the UPDATE only applies while the row is still ACTIVE,
 * so concurrent re-triage commands cannot both supersede the same decision
 * (the CR-HM-BE-01 closure-hardening idiom). Returns null when the guard
 * fails.
 */
async function supersedeActive(
  id: string,
  actorUserId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestTriageRecord | null> {
  const result = await executor.query<HandymanRequestTriageRecord>(
    `UPDATE handyman_request_triages
     SET status = 'SUPERSEDED',
         superseded_at = NOW(),
         superseded_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${TRIAGE_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ?? null;
}

export const handymanRequestTriageRepository = {
  create,
  findActiveByRequest,
  findById,
  listByRequest,
  supersedeActive,
};

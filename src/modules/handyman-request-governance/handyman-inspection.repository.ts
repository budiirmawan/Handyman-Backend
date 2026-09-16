import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { HandymanInspectionRecord } from './handyman-request-governance.types';

/**
 * CR-HM-BE-03 RUN 1 — Inspection persistence.
 *
 * One OPEN inspection per request is structurally enforced by the partial
 * unique index `handyman_inspections_one_open_per_request` (migration 0350).
 * COMPLETED rows are immutable: the only write paths are the guarded
 * OPEN → COMPLETED and OPEN → CANCELLED transitions below.
 */

const INSPECTION_SELECT = `
  id,
  request_id AS "requestId",
  client_id AS "clientId",
  building_id AS "buildingId",
  space_id AS "spaceId",
  status,
  diagnosis,
  scope_notes AS "scopeNotes",
  checklist_execution_id AS "checklistExecutionId",
  opened_by_user_id AS "openedByUserId",
  opened_at AS "openedAt",
  inspected_by_user_id AS "inspectedByUserId",
  inspected_at AS "inspectedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: {
    requestId: string;
    clientId: string;
    buildingId: string;
    spaceId: string;
    checklistExecutionId: string | null;
    openedByUserId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanInspectionRecord> {
  const result = await executor.query<HandymanInspectionRecord>(
    `INSERT INTO handyman_inspections
       (id, request_id, client_id, building_id, space_id,
        checklist_execution_id, opened_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${INSPECTION_SELECT}`,
    [
      randomUUID(),
      input.requestId,
      input.clientId,
      input.buildingId,
      input.spaceId,
      input.checklistExecutionId,
      input.openedByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanInspectionRecord | null> {
  const result = await executor.query<HandymanInspectionRecord>(
    `SELECT ${INSPECTION_SELECT} FROM handyman_inspections WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findOpenByRequest(
  requestId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanInspectionRecord | null> {
  const result = await executor.query<HandymanInspectionRecord>(
    `SELECT ${INSPECTION_SELECT}
     FROM handyman_inspections
     WHERE request_id = $1 AND status = 'OPEN'`,
    [requestId],
  );
  return result.rows[0] ?? null;
}

async function listByRequest(
  requestId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanInspectionRecord[]> {
  const result = await executor.query<HandymanInspectionRecord>(
    `SELECT ${INSPECTION_SELECT}
     FROM handyman_inspections
     WHERE request_id = $1
     ORDER BY opened_at ASC, id ASC`,
    [requestId],
  );
  return result.rows;
}

async function countCompletedByRequest(
  requestId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<number> {
  const result = await executor.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM handyman_inspections
     WHERE request_id = $1 AND status = 'COMPLETED'`,
    [requestId],
  );
  return result.rows[0]?.n ?? 0;
}

/**
 * Guarded OPEN → COMPLETED transition. Diagnosis and scope notes are written
 * exactly once, atomically with the transition; a losing concurrent command
 * gets null (the row is no longer OPEN).
 */
async function completeFromOpen(
  id: string,
  input: { diagnosis: string; scopeNotes: string },
  actorUserId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanInspectionRecord | null> {
  const result = await executor.query<HandymanInspectionRecord>(
    `UPDATE handyman_inspections
     SET status = 'COMPLETED',
         diagnosis = $2,
         scope_notes = $3,
         inspected_by_user_id = $4,
         inspected_at = NOW(),
         updated_at = NOW()
     WHERE id = $1 AND status = 'OPEN'
     RETURNING ${INSPECTION_SELECT}`,
    [id, input.diagnosis, input.scopeNotes, actorUserId],
  );
  return result.rows[0] ?? null;
}

/** Guarded OPEN → CANCELLED transition. */
async function cancelFromOpen(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanInspectionRecord | null> {
  const result = await executor.query<HandymanInspectionRecord>(
    `UPDATE handyman_inspections
     SET status = 'CANCELLED', updated_at = NOW()
     WHERE id = $1 AND status = 'OPEN'
     RETURNING ${INSPECTION_SELECT}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const handymanInspectionRepository = {
  cancelFromOpen,
  completeFromOpen,
  countCompletedByRequest,
  create,
  findOpenByRequest,
  findById,
  listByRequest,
};

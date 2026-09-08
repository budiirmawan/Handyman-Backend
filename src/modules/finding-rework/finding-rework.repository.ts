import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { FindingReworkRecord } from './finding-rework.types';

type Row = FindingReworkRecord;
const SELECT = `id, finding_id AS "findingId", review_id AS "reviewId",
  requested_by_user_id AS "requestedByUserId", reason,
  rework_notes AS "reworkNotes",
  resubmitted_by_user_id AS "resubmittedByUserId",
  requested_at AS "requestedAt", resubmitted_at AS "resubmittedAt",
  status, created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: {
  findingId: string;
  reviewId: string;
  requestedByUserId: string;
  reason: string;
}): Promise<Row> {
  const result = await getPool().query<Row>(
    `INSERT INTO finding_rework_cycles
       (id, finding_id, review_id, requested_by_user_id, reason)
     VALUES ($1,$2,$3,$4,$5) RETURNING ${SELECT}`,
    [randomUUID(), input.findingId, input.reviewId, input.requestedByUserId, input.reason],
  );
  return result.rows[0];
}
async function findCurrent(findingId: string): Promise<Row | null> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM finding_rework_cycles
     WHERE finding_id=$1 AND status='REQUESTED'
     ORDER BY requested_at DESC LIMIT 1`,
    [findingId],
  );
  return result.rows[0] ?? null;
}
async function listByFindingId(findingId: string): Promise<Row[]> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM finding_rework_cycles
     WHERE finding_id=$1 ORDER BY requested_at, id`,
    [findingId],
  );
  return result.rows;
}
async function updateNotes(id: string, notes: string): Promise<Row | null> {
  const result = await getPool().query<Row>(
    `UPDATE finding_rework_cycles
     SET rework_notes=$2, updated_at=NOW()
     WHERE id=$1 AND status='REQUESTED' RETURNING ${SELECT}`,
    [id, notes],
  );
  return result.rows[0] ?? null;
}
async function markResubmitted(
  id: string,
  userId: string,
  notes: string,
): Promise<Row | null> {
  const result = await getPool().query<Row>(
    `UPDATE finding_rework_cycles
     SET rework_notes=$3, resubmitted_by_user_id=$2,
         resubmitted_at=NOW(), status='RESUBMITTED', updated_at=NOW()
     WHERE id=$1 AND status='REQUESTED' RETURNING ${SELECT}`,
    [id, userId, notes],
  );
  return result.rows[0] ?? null;
}

export const findingReworkRepository = {
  create,
  findCurrent,
  listByFindingId,
  markResubmitted,
  updateNotes,
};

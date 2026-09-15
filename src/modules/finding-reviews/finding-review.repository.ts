import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { ReviewDecision } from '../reviews';
import type { FindingReviewRecord } from './finding-review.types';

type Row = {
  id: string;
  clientId: string;
  findingId: string;
  reviewerUserId: string;
  decision: ReviewDecision | null;
  notes: string | null;
  reviewedAt: Date | null;
  status: 'PENDING' | 'COMPLETED';
  createdAt: Date;
  updatedAt: Date;
};
const SELECT = `id, client_id AS "clientId", target_id AS "findingId",
  reviewer_user_id AS "reviewerUserId", decision, notes,
  reviewed_at AS "reviewedAt", status, created_at AS "createdAt",
  updated_at AS "updatedAt"`;

async function createPending(input: {
  clientId: string;
  findingId: string;
  reviewerUserId: string;
  notes: string | null;
}): Promise<FindingReviewRecord> {
  const result = await getPool().query<Row>(
    `INSERT INTO reviews
       (id, client_id, target_type, target_id, reviewer_user_id, notes, status)
     VALUES ($1,$2,'FINDING',$3,$4,$5,'PENDING') RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.findingId, input.reviewerUserId, input.notes],
  );
  return result.rows[0];
}
async function findPendingByFindingId(findingId: string): Promise<FindingReviewRecord | null> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM reviews
     WHERE target_type='FINDING' AND target_id=$1 AND status='PENDING'
     ORDER BY created_at DESC LIMIT 1`,
    [findingId],
  );
  return result.rows[0] ?? null;
}
async function listByFindingId(findingId: string): Promise<FindingReviewRecord[]> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM reviews
     WHERE target_type='FINDING' AND target_id=$1
     ORDER BY created_at, id`,
    [findingId],
  );
  return result.rows;
}
async function complete(
  id: string,
  decision: ReviewDecision,
  notes: string | null,
): Promise<FindingReviewRecord | null> {
  const result = await getPool().query<Row>(
    `UPDATE reviews
     SET decision=$2, notes=$3, status='COMPLETED', reviewed_at=NOW(),
         updated_at=NOW()
     WHERE id=$1 AND target_type='FINDING' AND status='PENDING'
     RETURNING ${SELECT}`,
    [id, decision, notes],
  );
  return result.rows[0] ?? null;
}

export const findingReviewRepository = {
  complete,
  createPending,
  findPendingByFindingId,
  listByFindingId,
};

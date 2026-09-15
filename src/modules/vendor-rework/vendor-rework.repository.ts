import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { VendorReworkRecord } from './vendor-rework.types';

/**
 * BE-15J — Vendor Work Rework repository.
 *
 * Holds append-preserving rework cycles for a BE-15B Vendor Work. Every cycle
 * references the BE-07 review (BE-15I verification) that produced
 * REWORK_REQUIRED — no duplicated verification record is created here.
 */

type Row = {
  id: string;
  vendorWorkId: string;
  reviewId: string;
  requestedByUserId: string;
  reason: string;
  reworkNotes: string | null;
  resubmittedByUserId: string | null;
  requestedAt: Date;
  resubmittedAt: Date | null;
  status: 'REQUESTED' | 'RESUBMITTED';
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `id,
  vendor_work_id AS "vendorWorkId",
  review_id AS "reviewId",
  requested_by_user_id AS "requestedByUserId",
  reason,
  rework_notes AS "reworkNotes",
  resubmitted_by_user_id AS "resubmittedByUserId",
  requested_at AS "requestedAt",
  resubmitted_at AS "resubmittedAt",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

async function create(input: {
  vendorWorkId: string;
  reviewId: string;
  requestedByUserId: string;
  reason: string;
}): Promise<Row> {
  const result = await getPool().query<Row>(
    `INSERT INTO vendor_rework_cycles
       (id, vendor_work_id, review_id, requested_by_user_id, reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.vendorWorkId,
      input.reviewId,
      input.requestedByUserId,
      input.reason,
    ],
  );
  return result.rows[0];
}

async function findCurrent(vendorWorkId: string): Promise<Row | null> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM vendor_rework_cycles
     WHERE vendor_work_id = $1 AND status = 'REQUESTED'
     ORDER BY requested_at DESC LIMIT 1`,
    [vendorWorkId],
  );
  return result.rows[0] ?? null;
}

async function listByVendorWorkId(vendorWorkId: string): Promise<Row[]> {
  const result = await getPool().query<Row>(
    `SELECT ${SELECT} FROM vendor_rework_cycles
     WHERE vendor_work_id = $1 ORDER BY requested_at, id`,
    [vendorWorkId],
  );
  return result.rows;
}

async function updateNotes(id: string, notes: string): Promise<Row | null> {
  const result = await getPool().query<Row>(
    `UPDATE vendor_rework_cycles
     SET rework_notes = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'REQUESTED' RETURNING ${SELECT}`,
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
    `UPDATE vendor_rework_cycles
     SET rework_notes = $3,
         resubmitted_by_user_id = $2,
         resubmitted_at = NOW(),
         status = 'RESUBMITTED',
         updated_at = NOW()
     WHERE id = $1 AND status = 'REQUESTED' RETURNING ${SELECT}`,
    [id, userId, notes],
  );
  return result.rows[0] ?? null;
}

export const vendorReworkRepository = {
  create,
  findCurrent,
  listByVendorWorkId,
  markResubmitted,
  updateNotes,
};

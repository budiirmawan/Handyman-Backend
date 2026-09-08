import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  VisitCheckInListFilters,
  VisitCheckInRecord,
  VisitCheckInStatus,
} from './visit-check-in.types';

/**
 * BE-13G — Check-In repository.
 *
 * One active check-in per visit context (partial unique indexes). All
 * access rules live in the service layer.
 */

type VisitCheckInRow = {
  id: string;
  client_id: string;
  building_id: string;
  visitor_id: string;
  expected_visitor_id: string | null;
  walk_in_visit_id: string | null;
  checked_in_at: Date;
  checked_in_by_user_id: string;
  entry_notes: string | null;
  checked_out_at: Date | null;
  checked_out_by_user_id: string | null;
  exit_notes: string | null;
  status: VisitCheckInStatus;
  created_at: Date;
  updated_at: Date;
};

const VISIT_CHECK_IN_COLUMNS = `
  id, client_id, building_id, visitor_id,
  expected_visitor_id, walk_in_visit_id,
  checked_in_at, checked_in_by_user_id, entry_notes,
  checked_out_at, checked_out_by_user_id, exit_notes, status,
  created_at, updated_at
`;

function mapRow(row: VisitCheckInRow): VisitCheckInRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    visitorId: row.visitor_id,
    expectedVisitorId: row.expected_visitor_id,
    walkInVisitId: row.walk_in_visit_id,
    checkedInAt: row.checked_in_at,
    checkedInByUserId: row.checked_in_by_user_id,
    entryNotes: row.entry_notes,
    checkedOutAt: row.checked_out_at,
    checkedOutByUserId: row.checked_out_by_user_id,
    exitNotes: row.exit_notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateVisitCheckInRow = {
  clientId: string;
  buildingId: string;
  visitorId: string;
  expectedVisitorId: string | null;
  walkInVisitId: string | null;
  checkedInAt: string | null;
  checkedInByUserId: string;
  entryNotes: string | null;
};

export async function create(
  input: CreateVisitCheckInRow,
): Promise<VisitCheckInRecord> {
  const result = await getPool().query<VisitCheckInRow>(
    `INSERT INTO visit_check_ins
       (id, client_id, building_id, visitor_id,
        expected_visitor_id, walk_in_visit_id,
        checked_in_at, checked_in_by_user_id, entry_notes)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, NOW()), $8, $9)
     RETURNING ${VISIT_CHECK_IN_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.visitorId,
      input.expectedVisitorId,
      input.walkInVisitId,
      input.checkedInAt,
      input.checkedInByUserId,
      input.entryNotes,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<VisitCheckInRecord | null> {
  const result = await getPool().query<VisitCheckInRow>(
    `SELECT ${VISIT_CHECK_IN_COLUMNS}
     FROM visit_check_ins WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** The active (CHECKED_IN) row for an Expected Visitor, if any. */
export async function findActiveByExpectedVisitor(
  expectedVisitorId: string,
): Promise<VisitCheckInRecord | null> {
  const result = await getPool().query<VisitCheckInRow>(
    `SELECT ${VISIT_CHECK_IN_COLUMNS}
     FROM visit_check_ins
     WHERE expected_visitor_id = $1 AND status = 'CHECKED_IN'`,
    [expectedVisitorId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** The active (CHECKED_IN) row for a Walk-In visit, if any. */
export async function findActiveByWalkInVisit(
  walkInVisitId: string,
): Promise<VisitCheckInRecord | null> {
  const result = await getPool().query<VisitCheckInRow>(
    `SELECT ${VISIT_CHECK_IN_COLUMNS}
     FROM visit_check_ins
     WHERE walk_in_visit_id = $1 AND status = 'CHECKED_IN'`,
    [walkInVisitId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: VisitCheckInListFilters = {},
): Promise<VisitCheckInRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = ['building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filter.visitorId) {
    values.push(filter.visitorId);
    conditions.push(`visitor_id = $${values.length}`);
  }
  if (filter.expectedVisitorId) {
    values.push(filter.expectedVisitorId);
    conditions.push(`expected_visitor_id = $${values.length}`);
  }
  if (filter.walkInVisitId) {
    values.push(filter.walkInVisitId);
    conditions.push(`walk_in_visit_id = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filter.checkedInFrom) {
    values.push(filter.checkedInFrom);
    conditions.push(`checked_in_at >= $${values.length}`);
  }
  if (filter.checkedInTo) {
    values.push(filter.checkedInTo);
    conditions.push(`checked_in_at <= $${values.length}`);
  }
  if (filter.checkedOutFrom) {
    values.push(filter.checkedOutFrom);
    conditions.push(`checked_out_at >= $${values.length}`);
  }
  if (filter.checkedOutTo) {
    values.push(filter.checkedOutTo);
    conditions.push(`checked_out_at <= $${values.length}`);
  }

  const result = await getPool().query<VisitCheckInRow>(
    `SELECT ${VISIT_CHECK_IN_COLUMNS}
     FROM visit_check_ins
     WHERE ${conditions.join(' AND ')}
     ORDER BY checked_in_at DESC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

/**
 * Cancels an active check-in atomically: the WHERE clause guards
 * `status = 'CHECKED_IN'` so a concurrent cancel cannot double-apply.
 */
export async function cancel(id: string): Promise<VisitCheckInRecord | null> {
  const result = await getPool().query<VisitCheckInRow>(
    `UPDATE visit_check_ins
     SET status = 'CANCELLED', updated_at = NOW()
     WHERE id = $1 AND status = 'CHECKED_IN'
     RETURNING ${VISIT_CHECK_IN_COLUMNS}`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * BE-13H — closes an active visit atomically. The WHERE clause guards
 * `status = 'CHECKED_IN'` so a duplicate check-out (or a race against
 * cancel) can never double-apply. The original check-in columns are
 * untouched — history is preserved on the same row.
 */
export async function checkOut(
  id: string,
  input: {
    checkedOutAt: string | null;
    checkedOutByUserId: string;
    exitNotes: string | null;
  },
): Promise<VisitCheckInRecord | null> {
  const result = await getPool().query<VisitCheckInRow>(
    `UPDATE visit_check_ins
     SET status = 'CHECKED_OUT',
         checked_out_at = COALESCE($2, NOW()),
         checked_out_by_user_id = $3,
         exit_notes = $4,
         updated_at = NOW()
     WHERE id = $1 AND status = 'CHECKED_IN'
     RETURNING ${VISIT_CHECK_IN_COLUMNS}`,
    [id, input.checkedOutAt, input.checkedOutByUserId, input.exitNotes],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const visitCheckInRepository = {
  cancel,
  checkOut,
  create,
  findActiveByExpectedVisitor,
  findActiveByWalkInVisit,
  findById,
  listByBuildingIds,
};

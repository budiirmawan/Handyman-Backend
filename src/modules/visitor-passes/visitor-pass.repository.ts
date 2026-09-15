import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  VisitorPassListFilters,
  VisitorPassRecord,
  VisitorPassStatus,
} from './visitor-pass.types';

type VisitorPassRow = {
  id: string;
  client_id: string;
  building_id: string;
  visit_check_in_id: string;
  pass_code: string;
  issued_at: Date;
  issued_by_user_id: string;
  status: VisitorPassStatus;
  returned_at: Date | null;
  returned_by_user_id: string | null;
  cancelled_at: Date | null;
  cancelled_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
};

const VISITOR_PASS_COLUMNS = `
  id, client_id, building_id, visit_check_in_id, pass_code,
  issued_at, issued_by_user_id, status,
  returned_at, returned_by_user_id,
  cancelled_at, cancelled_by_user_id,
  created_at, updated_at
`;

function mapRow(row: VisitorPassRow): VisitorPassRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    visitCheckInId: row.visit_check_in_id,
    passCode: row.pass_code,
    issuedAt: row.issued_at,
    issuedByUserId: row.issued_by_user_id,
    status: row.status,
    returnedAt: row.returned_at,
    returnedByUserId: row.returned_by_user_id,
    cancelledAt: row.cancelled_at,
    cancelledByUserId: row.cancelled_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: {
  clientId: string;
  buildingId: string;
  visitCheckInId: string;
  passCode: string;
  issuedAt: string | null;
  issuedByUserId: string;
}): Promise<VisitorPassRecord> {
  const result = await getPool().query<VisitorPassRow>(
    `INSERT INTO visitor_passes
       (id, client_id, building_id, visit_check_in_id, pass_code,
        issued_at, issued_by_user_id)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, NOW()), $7)
     RETURNING ${VISITOR_PASS_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.visitCheckInId,
      input.passCode,
      input.issuedAt,
      input.issuedByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(id: string): Promise<VisitorPassRecord | null> {
  const result = await getPool().query<VisitorPassRow>(
    `SELECT ${VISITOR_PASS_COLUMNS}
     FROM visitor_passes
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByCode(
  passCode: string,
): Promise<VisitorPassRecord | null> {
  const result = await getPool().query<VisitorPassRow>(
    `SELECT ${VISITOR_PASS_COLUMNS}
     FROM visitor_passes
     WHERE pass_code = $1`,
    [passCode],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByVisitCheckInId(
  visitCheckInId: string,
): Promise<VisitorPassRecord | null> {
  const result = await getPool().query<VisitorPassRow>(
    `SELECT ${VISITOR_PASS_COLUMNS}
     FROM visitor_passes
     WHERE visit_check_in_id = $1 AND status = 'ACTIVE'`,
    [visitCheckInId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filters: VisitorPassListFilters = {},
): Promise<VisitorPassRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }

  const conditions = ['building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filters.status) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.visitCheckInId) {
    values.push(filters.visitCheckInId);
    conditions.push(`visit_check_in_id = $${values.length}`);
  }

  const result = await getPool().query<VisitorPassRow>(
    `SELECT ${VISITOR_PASS_COLUMNS}
     FROM visitor_passes
     WHERE ${conditions.join(' AND ')}
     ORDER BY issued_at DESC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function markReturned(
  id: string,
  input: { returnedAt: string | null; returnedByUserId: string },
): Promise<VisitorPassRecord | null> {
  const result = await getPool().query<VisitorPassRow>(
    `UPDATE visitor_passes
     SET status = 'RETURNED',
         returned_at = COALESCE($2, NOW()),
         returned_by_user_id = $3,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${VISITOR_PASS_COLUMNS}`,
    [id, input.returnedAt, input.returnedByUserId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function cancel(
  id: string,
  cancelledByUserId: string,
): Promise<VisitorPassRecord | null> {
  const result = await getPool().query<VisitorPassRow>(
    `UPDATE visitor_passes
     SET status = 'CANCELLED',
         cancelled_at = NOW(),
         cancelled_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE'
     RETURNING ${VISITOR_PASS_COLUMNS}`,
    [id, cancelledByUserId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const visitorPassRepository = {
  cancel,
  create,
  findActiveByVisitCheckInId,
  findByCode,
  findById,
  listByBuildingIds,
  markReturned,
};

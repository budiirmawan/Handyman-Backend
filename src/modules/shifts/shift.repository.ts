import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewShift,
  ShiftRecord,
  ShiftStatus,
} from './shift.types';

type ShiftRow = {
  id: string;
  client_id: string;
  building_id: string;
  code: string;
  name: string;
  start_time: string;
  end_time: string;
  status: ShiftStatus;
  created_at: Date;
  updated_at: Date;
};

/**
 * `start_time` / `end_time` are TIME columns. `pg` hands them back as
 * `HH:MM:SS` strings, which is exactly the representation the API exposes, so
 * no conversion is needed in either direction.
 */
const SHIFT_SELECT = `
  id,
  client_id,
  building_id,
  code,
  name,
  start_time,
  end_time,
  status,
  created_at,
  updated_at
`;

function mapRow(row: ShiftRow): ShiftRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    code: row.code,
    name: row.name,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(input: NewShift): Promise<ShiftRecord> {
  const result = await getPool().query<ShiftRow>(
    `INSERT INTO shifts
       (id, client_id, building_id, code, name, start_time, end_time, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SHIFT_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.code,
      input.name,
      input.startTime,
      input.endTime,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<ShiftRecord | null> {
  const result = await getPool().query<ShiftRow>(
    `SELECT ${SHIFT_SELECT} FROM shifts WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Duplicate-code probe. Scoped to the Building, matching the unique key. */
async function findByCodeForBuilding(
  buildingId: string,
  code: string,
): Promise<ShiftRecord | null> {
  const result = await getPool().query<ShiftRow>(
    `SELECT ${SHIFT_SELECT} FROM shifts WHERE building_id = $1 AND code = $2`,
    [buildingId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByBuilding(buildingId: string): Promise<ShiftRecord[]> {
  const result = await getPool().query<ShiftRow>(
    `SELECT ${SHIFT_SELECT} FROM shifts
     WHERE building_id = $1
     ORDER BY start_time ASC, code ASC`,
    [buildingId],
  );

  return result.rows.map(mapRow);
}

async function updateStatus(
  id: string,
  status: ShiftStatus,
): Promise<ShiftRecord | null> {
  const result = await getPool().query<ShiftRow>(
    `UPDATE shifts
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${SHIFT_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const shiftRepository = {
  create,
  findByCodeForBuilding,
  findById,
  listByBuilding,
  updateStatus,
};

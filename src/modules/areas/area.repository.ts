import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AreaRecord,
  AreaStatus,
  NewArea,
  UpdateAreaInput,
} from './area.types';

type AreaRow = {
  id: string;
  floorId: string;
  code: string;
  name: string;
  type: AreaRecord['type'];
  description: string | null;
  status: AreaStatus;
  createdAt: Date;
  updatedAt: Date;
};

const AREA_SELECT = `
  id,
  floor_id AS "floorId",
  code,
  name,
  type,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapAreaRow(row: AreaRow): AreaRecord {
  return {
    id: row.id,
    floorId: row.floorId,
    code: row.code,
    name: row.name,
    type: row.type,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createArea(input: NewArea): Promise<AreaRecord> {
  const result = await getPool().query<AreaRow>(
    `INSERT INTO areas
       (id, floor_id, code, name, type, description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${AREA_SELECT}`,
    [
      randomUUID(),
      input.floorId,
      input.code,
      input.name,
      input.type,
      input.description,
      input.status,
    ],
  );

  return mapAreaRow(result.rows[0]);
}

async function findById(id: string): Promise<AreaRecord | null> {
  const result = await getPool().query<AreaRow>(
    `SELECT ${AREA_SELECT} FROM areas WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapAreaRow(row) : null;
}

async function findByCodeForFloor(
  floorId: string,
  code: string,
): Promise<AreaRecord | null> {
  const result = await getPool().query<AreaRow>(
    `SELECT ${AREA_SELECT} FROM areas
     WHERE floor_id = $1 AND code = $2`,
    [floorId, code],
  );

  const row = result.rows[0];
  return row ? mapAreaRow(row) : null;
}

async function listByFloor(floorId: string): Promise<AreaRecord[]> {
  const result = await getPool().query<AreaRow>(
    `SELECT ${AREA_SELECT} FROM areas
     WHERE floor_id = $1 ORDER BY code ASC`,
    [floorId],
  );

  return result.rows.map(mapAreaRow);
}

async function updateArea(
  id: string,
  input: UpdateAreaInput,
): Promise<AreaRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.type !== undefined) {
    values.push(input.type);
    sets.push(`type = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<AreaRow>(
    `UPDATE areas SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${AREA_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapAreaRow(row) : null;
}

async function updateStatus(
  id: string,
  status: AreaStatus,
): Promise<AreaRecord | null> {
  const result = await getPool().query<AreaRow>(
    `UPDATE areas SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${AREA_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapAreaRow(row) : null;
}

export const areaRepository = {
  createArea,
  findByCodeForFloor,
  findById,
  listByFloor,
  updateArea,
  updateStatus,
};

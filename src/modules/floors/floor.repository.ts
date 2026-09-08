import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  FloorRecord,
  FloorStatus,
  NewFloor,
  UpdateFloorInput,
} from './floor.types';

type FloorRow = {
  id: string;
  buildingId: string;
  code: string;
  name: string;
  levelNumber: number;
  description: string | null;
  status: FloorStatus;
  createdAt: Date;
  updatedAt: Date;
};

const FLOOR_SELECT = `
  id,
  building_id AS "buildingId",
  code,
  name,
  level_number AS "levelNumber",
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapFloorRow(row: FloorRow): FloorRecord {
  return {
    id: row.id,
    buildingId: row.buildingId,
    code: row.code,
    name: row.name,
    levelNumber: row.levelNumber,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createFloor(input: NewFloor): Promise<FloorRecord> {
  const result = await getPool().query<FloorRow>(
    `INSERT INTO floors
       (id, building_id, code, name, level_number, description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${FLOOR_SELECT}`,
    [
      randomUUID(),
      input.buildingId,
      input.code,
      input.name,
      input.levelNumber,
      input.description,
      input.status,
    ],
  );

  return mapFloorRow(result.rows[0]);
}

async function findById(id: string): Promise<FloorRecord | null> {
  const result = await getPool().query<FloorRow>(
    `SELECT ${FLOOR_SELECT} FROM floors WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapFloorRow(row) : null;
}

async function findByCodeForBuilding(
  buildingId: string,
  code: string,
): Promise<FloorRecord | null> {
  const result = await getPool().query<FloorRow>(
    `SELECT ${FLOOR_SELECT} FROM floors
     WHERE building_id = $1 AND code = $2`,
    [buildingId, code],
  );

  const row = result.rows[0];
  return row ? mapFloorRow(row) : null;
}

async function listByBuilding(buildingId: string): Promise<FloorRecord[]> {
  const result = await getPool().query<FloorRow>(
    `SELECT ${FLOOR_SELECT} FROM floors
     WHERE building_id = $1
     ORDER BY level_number ASC, code ASC`,
    [buildingId],
  );

  return result.rows.map(mapFloorRow);
}

async function updateFloor(
  id: string,
  input: UpdateFloorInput,
): Promise<FloorRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.levelNumber !== undefined) {
    values.push(input.levelNumber);
    sets.push(`level_number = $${values.length}`);
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

  const result = await getPool().query<FloorRow>(
    `UPDATE floors SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${FLOOR_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapFloorRow(row) : null;
}

async function updateStatus(
  id: string,
  status: FloorStatus,
): Promise<FloorRecord | null> {
  const result = await getPool().query<FloorRow>(
    `UPDATE floors SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${FLOOR_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapFloorRow(row) : null;
}

export const floorRepository = {
  createFloor,
  findByCodeForBuilding,
  findById,
  listByBuilding,
  updateFloor,
  updateStatus,
};

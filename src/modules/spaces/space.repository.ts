import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewSpace,
  SpaceRecord,
  SpaceStatus,
  UpdateSpaceInput,
} from './space.types';

type SpaceRow = {
  id: string;
  roomId: string;
  code: string;
  name: string;
  description: string | null;
  areaSqm: string | null;
  status: SpaceStatus;
  createdAt: Date;
  updatedAt: Date;
};

const SPACE_SELECT = `
  id,
  room_id AS "roomId",
  code,
  name,
  description,
  area_sqm::text AS "areaSqm",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapSpaceRow(row: SpaceRow): SpaceRecord {
  return {
    id: row.id,
    roomId: row.roomId,
    code: row.code,
    name: row.name,
    description: row.description,
    areaSqm: row.areaSqm,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createSpace(input: NewSpace): Promise<SpaceRecord> {
  const result = await getPool().query<SpaceRow>(
    `INSERT INTO spaces
       (id, room_id, code, name, description, area_sqm, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${SPACE_SELECT}`,
    [
      randomUUID(),
      input.roomId,
      input.code,
      input.name,
      input.description,
      input.areaSqm,
      input.status,
    ],
  );

  return mapSpaceRow(result.rows[0]);
}

async function findById(id: string): Promise<SpaceRecord | null> {
  const result = await getPool().query<SpaceRow>(
    `SELECT ${SPACE_SELECT} FROM spaces WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapSpaceRow(row) : null;
}

async function findByCodeForRoom(
  roomId: string,
  code: string,
): Promise<SpaceRecord | null> {
  const result = await getPool().query<SpaceRow>(
    `SELECT ${SPACE_SELECT} FROM spaces
     WHERE room_id = $1 AND code = $2`,
    [roomId, code],
  );

  const row = result.rows[0];
  return row ? mapSpaceRow(row) : null;
}

async function listByRoom(roomId: string): Promise<SpaceRecord[]> {
  const result = await getPool().query<SpaceRow>(
    `SELECT ${SPACE_SELECT} FROM spaces
     WHERE room_id = $1 ORDER BY code ASC`,
    [roomId],
  );

  return result.rows.map(mapSpaceRow);
}

async function updateSpace(
  id: string,
  input: UpdateSpaceInput,
): Promise<SpaceRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.areaSqm !== undefined) {
    values.push(input.areaSqm);
    sets.push(`area_sqm = $${values.length}`);
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

  const result = await getPool().query<SpaceRow>(
    `UPDATE spaces SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${SPACE_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapSpaceRow(row) : null;
}

async function updateStatus(
  id: string,
  status: SpaceStatus,
): Promise<SpaceRecord | null> {
  const result = await getPool().query<SpaceRow>(
    `UPDATE spaces SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${SPACE_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapSpaceRow(row) : null;
}

export const spaceRepository = {
  createSpace,
  findByCodeForRoom,
  findById,
  listByRoom,
  updateSpace,
  updateStatus,
};

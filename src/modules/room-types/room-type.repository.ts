import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewRoomType,
  RoomTypeRecord,
  RoomTypeStatus,
  UpdateRoomTypeInput,
} from './room-type.types';

type RoomTypeRow = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: RoomTypeStatus;
  createdAt: Date;
  updatedAt: Date;
};

const ROOM_TYPE_SELECT = `
  id,
  client_id AS "clientId",
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRoomTypeRow(row: RoomTypeRow): RoomTypeRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createRoomType(input: NewRoomType): Promise<RoomTypeRecord> {
  const result = await getPool().query<RoomTypeRow>(
    `INSERT INTO room_types
       (id, client_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ROOM_TYPE_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapRoomTypeRow(result.rows[0]);
}

async function findById(id: string): Promise<RoomTypeRecord | null> {
  const result = await getPool().query<RoomTypeRow>(
    `SELECT ${ROOM_TYPE_SELECT} FROM room_types WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRoomTypeRow(row) : null;
}

async function findByCodeForClient(
  clientId: string,
  code: string,
): Promise<RoomTypeRecord | null> {
  const result = await getPool().query<RoomTypeRow>(
    `SELECT ${ROOM_TYPE_SELECT} FROM room_types
     WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );

  const row = result.rows[0];
  return row ? mapRoomTypeRow(row) : null;
}

async function listByClient(clientId: string): Promise<RoomTypeRecord[]> {
  const result = await getPool().query<RoomTypeRow>(
    `SELECT ${ROOM_TYPE_SELECT} FROM room_types
     WHERE client_id = $1 ORDER BY code ASC`,
    [clientId],
  );

  return result.rows.map(mapRoomTypeRow);
}

async function updateRoomType(
  id: string,
  input: UpdateRoomTypeInput,
): Promise<RoomTypeRecord | null> {
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
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<RoomTypeRow>(
    `UPDATE room_types SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${ROOM_TYPE_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRoomTypeRow(row) : null;
}

async function updateStatus(
  id: string,
  status: RoomTypeStatus,
): Promise<RoomTypeRecord | null> {
  const result = await getPool().query<RoomTypeRow>(
    `UPDATE room_types SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ROOM_TYPE_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRoomTypeRow(row) : null;
}

export const roomTypeRepository = {
  createRoomType,
  findByCodeForClient,
  findById,
  listByClient,
  updateRoomType,
  updateStatus,
};

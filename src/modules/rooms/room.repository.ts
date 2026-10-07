import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewRoom,
  RoomRecord,
  RoomStatus,
  UpdateRoomInput,
} from './room.types';

type RoomRow = {
  id: string;
  areaId: string;
  roomTypeId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: RoomStatus;
  createdAt: Date;
  updatedAt: Date;
};

const ROOM_SELECT = `
  id,
  area_id AS "areaId",
  room_type_id AS "roomTypeId",
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRoomRow(row: RoomRow): RoomRecord {
  return {
    id: row.id,
    areaId: row.areaId,
    roomTypeId: row.roomTypeId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createRoom(input: NewRoom): Promise<RoomRecord> {
  const result = await getPool().query<RoomRow>(
    `INSERT INTO rooms
       (id, area_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${ROOM_SELECT}`,
    [
      randomUUID(),
      input.areaId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapRoomRow(result.rows[0]);
}

async function findById(id: string): Promise<RoomRecord | null> {
  const result = await getPool().query<RoomRow>(
    `SELECT ${ROOM_SELECT} FROM rooms WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRoomRow(row) : null;
}

async function findByCodeForArea(
  areaId: string,
  code: string,
): Promise<RoomRecord | null> {
  const result = await getPool().query<RoomRow>(
    `SELECT ${ROOM_SELECT} FROM rooms
     WHERE area_id = $1 AND code = $2`,
    [areaId, code],
  );

  const row = result.rows[0];
  return row ? mapRoomRow(row) : null;
}

async function listByArea(areaId: string): Promise<RoomRecord[]> {
  const result = await getPool().query<RoomRow>(
    `SELECT ${ROOM_SELECT} FROM rooms
     WHERE area_id = $1 ORDER BY code ASC`,
    [areaId],
  );

  return result.rows.map(mapRoomRow);
}

async function updateRoom(
  id: string,
  input: UpdateRoomInput,
): Promise<RoomRecord | null> {
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
  if (input.roomTypeId !== undefined) {
    values.push(input.roomTypeId);
    sets.push(`room_type_id = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<RoomRow>(
    `UPDATE rooms SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${ROOM_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRoomRow(row) : null;
}

async function updateStatus(
  id: string,
  status: RoomStatus,
): Promise<RoomRecord | null> {
  const result = await getPool().query<RoomRow>(
    `UPDATE rooms SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ROOM_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRoomRow(row) : null;
}

export const roomRepository = {
  createRoom,
  findByCodeForArea,
  findById,
  listByArea,
  updateRoom,
  updateStatus,
};

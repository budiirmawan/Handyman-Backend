import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreatePatrolRoutePointInput,
  PatrolRoutePointRecord,
  PatrolRoutePointStatus,
  UpdatePatrolRoutePointInput,
} from './patrol-route.types';

type PatrolRoutePointRow = {
  id: string;
  client_id: string;
  building_id: string;
  patrol_route_id: string;
  floor_id: string | null;
  area_id: string | null;
  room_id: string | null;
  space_id: string | null;
  functional_location_id: string | null;
  sequence: number;
  notes: string | null;
  status: PatrolRoutePointStatus;
  created_at: Date;
  updated_at: Date;
};

const PATROL_ROUTE_POINT_COLUMNS = `
  id, client_id, building_id, patrol_route_id, floor_id, area_id, room_id,
  space_id, functional_location_id, sequence, notes, status,
  created_at, updated_at
`;

function mapRow(row: PatrolRoutePointRow): PatrolRoutePointRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    patrolRouteId: row.patrol_route_id,
    floorId: row.floor_id,
    areaId: row.area_id,
    roomId: row.room_id,
    spaceId: row.space_id,
    functionalLocationId: row.functional_location_id,
    sequence: row.sequence,
    notes: row.notes,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: CreatePatrolRoutePointInput & {
    clientId: string;
    buildingId: string;
  },
): Promise<PatrolRoutePointRecord> {
  const result = await getPool().query<PatrolRoutePointRow>(
    `INSERT INTO patrol_route_points
       (id, client_id, building_id, patrol_route_id, floor_id, area_id,
        room_id, space_id, functional_location_id, sequence, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${PATROL_ROUTE_POINT_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.patrolRouteId,
      input.floorId ?? null,
      input.areaId ?? null,
      input.roomId ?? null,
      input.spaceId ?? null,
      input.functionalLocationId ?? null,
      input.sequence,
      input.notes ?? null,
      input.status ?? 'ACTIVE',
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<PatrolRoutePointRecord | null> {
  const result = await getPool().query<PatrolRoutePointRow>(
    `SELECT ${PATROL_ROUTE_POINT_COLUMNS}
     FROM patrol_route_points
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByRoute(
  patrolRouteId: string,
): Promise<PatrolRoutePointRecord[]> {
  const result = await getPool().query<PatrolRoutePointRow>(
    `SELECT ${PATROL_ROUTE_POINT_COLUMNS}
     FROM patrol_route_points
     WHERE patrol_route_id = $1
     ORDER BY sequence ASC`,
    [patrolRouteId],
  );
  return result.rows.map(mapRow);
}

export async function findByRouteAndSequence(
  patrolRouteId: string,
  sequence: number,
): Promise<PatrolRoutePointRecord | null> {
  const result = await getPool().query<PatrolRoutePointRow>(
    `SELECT ${PATROL_ROUTE_POINT_COLUMNS}
     FROM patrol_route_points
     WHERE patrol_route_id = $1 AND sequence = $2`,
    [patrolRouteId, sequence],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function update(
  id: string,
  input: UpdatePatrolRoutePointInput,
): Promise<PatrolRoutePointRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.floorId !== undefined) {
    values.push(input.floorId);
    sets.push(`floor_id = $${values.length}`);
  }

  if (input.areaId !== undefined) {
    values.push(input.areaId);
    sets.push(`area_id = $${values.length}`);
  }

  if (input.roomId !== undefined) {
    values.push(input.roomId);
    sets.push(`room_id = $${values.length}`);
  }

  if (input.spaceId !== undefined) {
    values.push(input.spaceId);
    sets.push(`space_id = $${values.length}`);
  }

  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }

  if (input.sequence !== undefined) {
    values.push(input.sequence);
    sets.push(`sequence = $${values.length}`);
  }

  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<PatrolRoutePointRow>(
    `UPDATE patrol_route_points
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${PATROL_ROUTE_POINT_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const patrolRoutePointRepository = {
  create,
  findById,
  findByRouteAndSequence,
  listByRoute,
  update,
};

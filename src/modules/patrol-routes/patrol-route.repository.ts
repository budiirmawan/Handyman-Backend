import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreatePatrolRouteInput,
  PatrolRouteFilter,
  PatrolRouteRecord,
  PatrolRouteStatus,
  UpdatePatrolRouteInput,
} from './patrol-route.types';

type PatrolRouteRow = {
  id: string;
  client_id: string;
  building_id: string;
  start_security_post_id: string | null;
  code: string;
  name: string;
  description: string | null;
  status: PatrolRouteStatus;
  created_at: Date;
  updated_at: Date;
};

const PATROL_ROUTE_COLUMNS = `
  id, client_id, building_id, start_security_post_id, code, name,
  description, status, created_at, updated_at
`;

function mapRow(row: PatrolRouteRow): PatrolRouteRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    startSecurityPostId: row.start_security_post_id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: CreatePatrolRouteInput & { clientId: string },
): Promise<PatrolRouteRecord> {
  const result = await getPool().query<PatrolRouteRow>(
    `INSERT INTO patrol_routes
       (id, client_id, building_id, start_security_post_id, code, name,
        description, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${PATROL_ROUTE_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.startSecurityPostId ?? null,
      input.code,
      input.name,
      input.description ?? null,
      input.status ?? 'ACTIVE',
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<PatrolRouteRecord | null> {
  const result = await getPool().query<PatrolRouteRow>(
    `SELECT ${PATROL_ROUTE_COLUMNS}
     FROM patrol_routes
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findByCodeForBuilding(
  buildingId: string,
  code: string,
): Promise<PatrolRouteRecord | null> {
  const result = await getPool().query<PatrolRouteRow>(
    `SELECT ${PATROL_ROUTE_COLUMNS}
     FROM patrol_routes
     WHERE building_id = $1 AND code = $2`,
    [buildingId, code],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuilding(
  buildingId: string,
  filter: PatrolRouteFilter = {},
): Promise<PatrolRouteRecord[]> {
  const conditions = ['building_id = $1'];
  const values: unknown[] = [buildingId];

  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  if (filter.startSecurityPostId !== undefined) {
    values.push(filter.startSecurityPostId);
    conditions.push(`start_security_post_id = $${values.length}`);
  }

  const result = await getPool().query<PatrolRouteRow>(
    `SELECT ${PATROL_ROUTE_COLUMNS}
     FROM patrol_routes
     WHERE ${conditions.join(' AND ')}
     ORDER BY code ASC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdatePatrolRouteInput,
): Promise<PatrolRouteRecord | null> {
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

  if (input.startSecurityPostId !== undefined) {
    values.push(input.startSecurityPostId);
    sets.push(`start_security_post_id = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<PatrolRouteRow>(
    `UPDATE patrol_routes
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${PATROL_ROUTE_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function updateStatus(
  id: string,
  status: PatrolRouteStatus,
): Promise<PatrolRouteRecord | null> {
  const result = await getPool().query<PatrolRouteRow>(
    `UPDATE patrol_routes
     SET status = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING ${PATROL_ROUTE_COLUMNS}`,
    [status, id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const patrolRouteRepository = {
  create,
  findByCodeForBuilding,
  findById,
  listByBuilding,
  update,
  updateStatus,
};

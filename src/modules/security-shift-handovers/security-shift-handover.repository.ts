import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateSecurityShiftHandoverBindingInput,
  SecurityShiftHandoverBindingFilter,
  SecurityShiftHandoverBindingRecord,
  SecurityShiftHandoverBindingStatus,
  UpdateSecurityShiftHandoverBindingInput,
} from './security-shift-handover.types';

type SecurityShiftHandoverBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  shift_handover_id: string;
  start_security_post_id: string | null;
  patrol_route_id: string | null;
  status: SecurityShiftHandoverBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const SECURITY_SHIFT_HANDOVER_BINDING_COLUMNS = `
  id, client_id, building_id, shift_handover_id, start_security_post_id,
  patrol_route_id, status, created_by_user_id, created_at, updated_at
`;

function mapRow(
  row: SecurityShiftHandoverBindingRow,
): SecurityShiftHandoverBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    shiftHandoverId: row.shift_handover_id,
    startSecurityPostId: row.start_security_post_id,
    patrolRouteId: row.patrol_route_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: CreateSecurityShiftHandoverBindingInput & { clientId: string },
): Promise<SecurityShiftHandoverBindingRecord> {
  const result = await getPool().query<SecurityShiftHandoverBindingRow>(
    `INSERT INTO security_shift_handover_bindings
       (id, client_id, building_id, shift_handover_id, start_security_post_id,
        patrol_route_id, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${SECURITY_SHIFT_HANDOVER_BINDING_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.shiftHandoverId,
      input.startSecurityPostId ?? null,
      input.patrolRouteId ?? null,
      input.status ?? 'ACTIVE',
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<SecurityShiftHandoverBindingRecord | null> {
  const result = await getPool().query<SecurityShiftHandoverBindingRow>(
    `SELECT ${SECURITY_SHIFT_HANDOVER_BINDING_COLUMNS}
     FROM security_shift_handover_bindings WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByHandoverId(
  shiftHandoverId: string,
): Promise<SecurityShiftHandoverBindingRecord | null> {
  const result = await getPool().query<SecurityShiftHandoverBindingRow>(
    `SELECT ${SECURITY_SHIFT_HANDOVER_BINDING_COLUMNS}
     FROM security_shift_handover_bindings
     WHERE shift_handover_id = $1 AND status = 'ACTIVE'`,
    [shiftHandoverId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: SecurityShiftHandoverBindingFilter = {},
): Promise<SecurityShiftHandoverBindingRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`building_id = $${values.length}`);
  }
  if (filter.shiftHandoverId) {
    values.push(filter.shiftHandoverId);
    conditions.push(`shift_handover_id = $${values.length}`);
  }
  if (filter.startSecurityPostId) {
    values.push(filter.startSecurityPostId);
    conditions.push(`start_security_post_id = $${values.length}`);
  }
  if (filter.patrolRouteId) {
    values.push(filter.patrolRouteId);
    conditions.push(`patrol_route_id = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<SecurityShiftHandoverBindingRow>(
    `SELECT ${SECURITY_SHIFT_HANDOVER_BINDING_COLUMNS}
     FROM security_shift_handover_bindings
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: SecurityShiftHandoverBindingFilter = {},
): Promise<SecurityShiftHandoverBindingRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = [`building_id = ANY($1::uuid[])`];
  const values: unknown[] = [buildingIds];

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filter.shiftHandoverId) {
    values.push(filter.shiftHandoverId);
    conditions.push(`shift_handover_id = $${values.length}`);
  }
  if (filter.startSecurityPostId) {
    values.push(filter.startSecurityPostId);
    conditions.push(`start_security_post_id = $${values.length}`);
  }
  if (filter.patrolRouteId) {
    values.push(filter.patrolRouteId);
    conditions.push(`patrol_route_id = $${values.length}`);
  }

  const result = await getPool().query<SecurityShiftHandoverBindingRow>(
    `SELECT ${SECURITY_SHIFT_HANDOVER_BINDING_COLUMNS}
     FROM security_shift_handover_bindings
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateSecurityShiftHandoverBindingInput,
): Promise<SecurityShiftHandoverBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.startSecurityPostId !== undefined) {
    values.push(input.startSecurityPostId);
    sets.push(`start_security_post_id = $${values.length}`);
  }
  if (input.patrolRouteId !== undefined) {
    values.push(input.patrolRouteId);
    sets.push(`patrol_route_id = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<SecurityShiftHandoverBindingRow>(
    `UPDATE security_shift_handover_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${SECURITY_SHIFT_HANDOVER_BINDING_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** A single authoritative read of the BE-10J shift_handovers row. */
export async function findShiftHandover(
  id: string,
): Promise<{
  id: string;
  client_id: string;
  building_id: string;
  status: string;
} | null> {
  const result = await getPool().query<{
    id: string;
    client_id: string;
    building_id: string;
    status: string;
  }>(
    `SELECT id, client_id, building_id, status
     FROM shift_handovers WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** A single authoritative read of the BE-12A security_posts row. */
export async function findSecurityPost(
  id: string,
): Promise<{
  id: string;
  client_id: string;
  building_id: string;
  code: string;
  name: string;
  status: string;
} | null> {
  const result = await getPool().query<{
    id: string;
    client_id: string;
    building_id: string;
    code: string;
    name: string;
    status: string;
  }>(
    `SELECT id, client_id, building_id, code, name, status
     FROM security_posts WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** A single authoritative read of the BE-12B patrol_routes row. */
export async function findPatrolRoute(
  id: string,
): Promise<{
  id: string;
  client_id: string;
  building_id: string;
  code: string;
  name: string;
  status: string;
} | null> {
  const result = await getPool().query<{
    id: string;
    client_id: string;
    building_id: string;
    code: string;
    name: string;
    status: string;
  }>(
    `SELECT id, client_id, building_id, code, name, status
     FROM patrol_routes WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const securityShiftHandoverBindingRepository = {
  create,
  findActiveByHandoverId,
  findById,
  findPatrolRoute,
  findSecurityPost,
  findShiftHandover,
  list,
  listByBuildingIds,
  update,
};

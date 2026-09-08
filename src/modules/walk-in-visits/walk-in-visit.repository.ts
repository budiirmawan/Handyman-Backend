import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  UpdateWalkInVisitInput,
  WalkInVisitListFilters,
  WalkInVisitRecord,
  WalkInVisitStatus,
} from './walk-in-visit.types';

/**
 * BE-13D — Walk-In / Guest Book repository.
 *
 * Holds guest-book rows referencing the shared BE-13A visitor identity
 * master. All access rules live in the service layer.
 */

type WalkInVisitRow = {
  id: string;
  client_id: string;
  building_id: string;
  visitor_id: string;
  host_user_id: string | null;
  host_workforce_id: string | null;
  host_name: string | null;
  purpose: string;
  arrived_at: Date;
  front_desk_notes: string | null;
  status: WalkInVisitStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const WALK_IN_VISIT_COLUMNS = `
  id, client_id, building_id, visitor_id,
  host_user_id, host_workforce_id, host_name,
  purpose, arrived_at, front_desk_notes, status,
  created_by_user_id, created_at, updated_at
`;

function mapRow(row: WalkInVisitRow): WalkInVisitRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    visitorId: row.visitor_id,
    hostUserId: row.host_user_id,
    hostWorkforceId: row.host_workforce_id,
    hostName: row.host_name,
    purpose: row.purpose,
    arrivedAt: row.arrived_at,
    frontDeskNotes: row.front_desk_notes,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type CreateWalkInVisitRow = {
  clientId: string;
  buildingId: string;
  visitorId: string;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
  purpose: string;
  arrivedAt: string | null;
  frontDeskNotes: string | null;
  createdByUserId: string;
};

export async function create(
  input: CreateWalkInVisitRow,
): Promise<WalkInVisitRecord> {
  const result = await getPool().query<WalkInVisitRow>(
    `INSERT INTO walk_in_visits
       (id, client_id, building_id, visitor_id,
        host_user_id, host_workforce_id, host_name,
        purpose, arrived_at, front_desk_notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()), $10, $11)
     RETURNING ${WALK_IN_VISIT_COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.visitorId,
      input.hostUserId,
      input.hostWorkforceId,
      input.hostName,
      input.purpose,
      input.arrivedAt,
      input.frontDeskNotes,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<WalkInVisitRecord | null> {
  const result = await getPool().query<WalkInVisitRow>(
    `SELECT ${WALK_IN_VISIT_COLUMNS}
     FROM walk_in_visits WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** The open (REGISTERED) entry for a visitor in a Building, if any. */
export async function findOpenByBuildingAndVisitor(
  buildingId: string,
  visitorId: string,
): Promise<WalkInVisitRecord | null> {
  const result = await getPool().query<WalkInVisitRow>(
    `SELECT ${WALK_IN_VISIT_COLUMNS}
     FROM walk_in_visits
     WHERE building_id = $1
       AND visitor_id = $2
       AND status = 'REGISTERED'`,
    [buildingId, visitorId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByBuildingIds(
  buildingIds: string[],
  filter: WalkInVisitListFilters = {},
): Promise<WalkInVisitRecord[]> {
  if (buildingIds.length === 0) {
    return [];
  }
  const conditions = ['building_id = ANY($1::uuid[])'];
  const values: unknown[] = [buildingIds];

  if (filter.visitorId) {
    values.push(filter.visitorId);
    conditions.push(`visitor_id = $${values.length}`);
  }
  if (filter.hostUserId) {
    values.push(filter.hostUserId);
    conditions.push(`host_user_id = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filter.arrivedFrom) {
    values.push(filter.arrivedFrom);
    conditions.push(`arrived_at >= $${values.length}`);
  }
  if (filter.arrivedTo) {
    values.push(filter.arrivedTo);
    conditions.push(`arrived_at <= $${values.length}`);
  }

  const result = await getPool().query<WalkInVisitRow>(
    `SELECT ${WALK_IN_VISIT_COLUMNS}
     FROM walk_in_visits
     WHERE ${conditions.join(' AND ')}
     ORDER BY arrived_at DESC, created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateWalkInVisitInput & { status?: WalkInVisitStatus },
): Promise<WalkInVisitRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.hostUserId !== undefined) {
    values.push(input.hostUserId);
    sets.push(`host_user_id = $${values.length}`);
  }
  if (input.hostWorkforceId !== undefined) {
    values.push(input.hostWorkforceId);
    sets.push(`host_workforce_id = $${values.length}`);
  }
  if (input.hostName !== undefined) {
    values.push(input.hostName);
    sets.push(`host_name = $${values.length}`);
  }
  if (input.purpose !== undefined) {
    values.push(input.purpose);
    sets.push(`purpose = $${values.length}`);
  }
  if (input.arrivedAt !== undefined) {
    values.push(input.arrivedAt);
    sets.push(`arrived_at = $${values.length}`);
  }
  if (input.frontDeskNotes !== undefined) {
    values.push(input.frontDeskNotes);
    sets.push(`front_desk_notes = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<WalkInVisitRow>(
    `UPDATE walk_in_visits
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING ${WALK_IN_VISIT_COLUMNS}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const walkInVisitRepository = {
  create,
  findById,
  findOpenByBuildingAndVisitor,
  listByBuildingIds,
  update,
};

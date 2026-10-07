import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewWorkRequest,
  UpdateWorkRequestInput,
  WorkRequestFilters,
  WorkRequestRecord,
  WorkRequestStatus,
} from './work-request.types';

type WorkRequestRow = {
  id: string;
  clientId: string;
  buildingId: string;
  requestNumber: string;
  title: string;
  description: string | null;
  requestType: string;
  requestedByUserId: string;
  requestedAt: Date;
  status: WorkRequestStatus;
  createdAt: Date;
  updatedAt: Date;
};

const WORK_REQUEST_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  request_number AS "requestNumber",
  title,
  description,
  request_type AS "requestType",
  requested_by_user_id AS "requestedByUserId",
  requested_at AS "requestedAt",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: WorkRequestRow): WorkRequestRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    requestNumber: row.requestNumber,
    title: row.title,
    description: row.description,
    requestType: row.requestType,
    requestedByUserId: row.requestedByUserId,
    requestedAt: row.requestedAt,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewWorkRequest,
): Promise<WorkRequestRecord> {
  const result = await getPool().query<WorkRequestRow>(
    `INSERT INTO work_requests
       (id, client_id, building_id, request_number, title, description,
        request_type, requested_by_user_id, requested_at, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), 'OPEN')
     RETURNING ${WORK_REQUEST_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.requestNumber,
      input.title,
      input.description,
      input.requestType,
      input.requestedByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<WorkRequestRecord | null> {
  const result = await getPool().query<WorkRequestRow>(
    `SELECT ${WORK_REQUEST_SELECT} FROM work_requests WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByRequestNumberForClient(
  clientId: string,
  requestNumber: string,
): Promise<WorkRequestRecord | null> {
  const result = await getPool().query<WorkRequestRow>(
    `SELECT ${WORK_REQUEST_SELECT} FROM work_requests
     WHERE client_id = $1 AND request_number = $2`,
    [clientId, requestNumber],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByBuilding(
  buildingId: string,
  filters: WorkRequestFilters,
): Promise<WorkRequestRecord[]> {
  const conditions: string[] = ['building_id = $1'];
  const values: unknown[] = [buildingId];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.requestType !== undefined) {
    values.push(filters.requestType);
    conditions.push(`request_type = $${values.length}`);
  }

  const result = await getPool().query<WorkRequestRow>(
    `SELECT ${WORK_REQUEST_SELECT} FROM work_requests
     WHERE ${conditions.join(' AND ')}
     ORDER BY requested_at DESC, created_at DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function update(
  id: string,
  input: UpdateWorkRequestInput,
): Promise<WorkRequestRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.title !== undefined) {
    values.push(input.title);
    sets.push(`title = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.requestType !== undefined) {
    values.push(input.requestType);
    sets.push(`request_type = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push('updated_at = NOW()');

  const result = await getPool().query<WorkRequestRow>(
    `UPDATE work_requests SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${WORK_REQUEST_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  id: string,
  status: WorkRequestStatus,
): Promise<WorkRequestRecord | null> {
  const result = await getPool().query<WorkRequestRow>(
    `UPDATE work_requests SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${WORK_REQUEST_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const workRequestRepository = {
  create,
  findById,
  findByRequestNumberForClient,
  listByBuilding,
  update,
  updateStatus,
};

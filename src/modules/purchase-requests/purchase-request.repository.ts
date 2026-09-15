import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPurchaseRequest,
  PurchaseRequestFilters,
  PurchaseRequestPriority,
  PurchaseRequestRecord,
  PurchaseRequestStatus,
  UpdatePurchaseRequestInput,
} from './purchase-request.types';

type PurchaseRequestRow = {
  id: string;
  clientId: string;
  buildingId: string;
  requestNumber: string;
  requesterReference: string | null;
  requestType: string;
  title: string;
  description: string | null;
  requiredDate: Date | null;
  priority: PurchaseRequestPriority;
  status: PurchaseRequestStatus;
  requestedByUserId: string;
  requestedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const PURCHASE_REQUEST_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  request_number AS "requestNumber",
  requester_reference AS "requesterReference",
  request_type AS "requestType",
  title,
  description,
  required_date AS "requiredDate",
  priority,
  status,
  requested_by_user_id AS "requestedByUserId",
  requested_at AS "requestedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: PurchaseRequestRow): PurchaseRequestRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    requestNumber: row.requestNumber,
    requesterReference: row.requesterReference,
    requestType: row.requestType,
    title: row.title,
    description: row.description,
    requiredDate: row.requiredDate,
    priority: row.priority,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    requestedAt: row.requestedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewPurchaseRequest,
): Promise<PurchaseRequestRecord> {
  const result = await getPool().query<PurchaseRequestRow>(
    `INSERT INTO purchase_requests
       (id, client_id, building_id, request_number, requester_reference,
        request_type, title, description, required_date, priority, status,
        requested_by_user_id, requested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'OPEN', $11, NOW())
     RETURNING ${PURCHASE_REQUEST_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.requestNumber,
      input.requesterReference,
      input.requestType,
      input.title,
      input.description,
      input.requiredDate,
      input.priority,
      input.requestedByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<PurchaseRequestRecord | null> {
  const result = await getPool().query<PurchaseRequestRow>(
    `SELECT ${PURCHASE_REQUEST_SELECT} FROM purchase_requests WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByRequestNumberForClient(
  clientId: string,
  requestNumber: string,
): Promise<PurchaseRequestRecord | null> {
  const result = await getPool().query<PurchaseRequestRow>(
    `SELECT ${PURCHASE_REQUEST_SELECT} FROM purchase_requests
     WHERE client_id = $1 AND request_number = $2`,
    [clientId, requestNumber],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByBuilding(
  buildingId: string,
  filters: PurchaseRequestFilters,
): Promise<PurchaseRequestRecord[]> {
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
  if (filters.requesterUserId !== undefined) {
    values.push(filters.requesterUserId);
    conditions.push(`requested_by_user_id = $${values.length}`);
  }
  if (filters.priority !== undefined) {
    values.push(filters.priority);
    conditions.push(`priority = $${values.length}`);
  }

  const result = await getPool().query<PurchaseRequestRow>(
    `SELECT ${PURCHASE_REQUEST_SELECT} FROM purchase_requests
     WHERE ${conditions.join(' AND ')}
     ORDER BY requested_at DESC, created_at DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function update(
  id: string,
  input: UpdatePurchaseRequestInput,
): Promise<PurchaseRequestRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.requesterReference !== undefined) {
    values.push(input.requesterReference);
    sets.push(`requester_reference = $${values.length}`);
  }
  if (input.requestType !== undefined) {
    values.push(input.requestType);
    sets.push(`request_type = $${values.length}`);
  }
  if (input.title !== undefined) {
    values.push(input.title);
    sets.push(`title = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.requiredDate !== undefined) {
    values.push(input.requiredDate);
    sets.push(`required_date = $${values.length}`);
  }
  if (input.priority !== undefined) {
    values.push(input.priority);
    sets.push(`priority = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push('updated_at = NOW()');

  const result = await getPool().query<PurchaseRequestRow>(
    `UPDATE purchase_requests SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${PURCHASE_REQUEST_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  id: string,
  status: PurchaseRequestStatus,
): Promise<PurchaseRequestRecord | null> {
  const result = await getPool().query<PurchaseRequestRow>(
    `UPDATE purchase_requests SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${PURCHASE_REQUEST_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const purchaseRequestRepository = {
  create,
  findById,
  findByRequestNumberForClient,
  listByBuilding,
  update,
  updateStatus,
};

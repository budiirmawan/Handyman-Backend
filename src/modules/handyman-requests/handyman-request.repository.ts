import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  CreateHandymanRequestRecordInput,
  HandymanRequestFilters,
  HandymanRequestRecord,
  HandymanRequestStatus,
} from './handyman-request.types';

const HANDYMAN_REQUEST_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  space_id AS "spaceId",
  tenant_company_id AS "tenantCompanyId",
  tenant_pic_id AS "tenantPicId",
  customer_name AS "customerName",
  customer_phone AS "customerPhone",
  customer_email AS "customerEmail",
  created_by_user_id AS "createdByUserId",
  operational_surface AS "operationalSurface",
  inbound_channel AS "inboundChannel",
  request_number AS "requestNumber",
  title,
  description,
  priority,
  status,
  idempotency_key AS "idempotencyKey",
  idempotency_fingerprint AS "idempotencyFingerprint",
  requested_at AS "requestedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestRecord | null> {
  const result = await executor.query<HandymanRequestRecord>(
    `SELECT ${HANDYMAN_REQUEST_SELECT}
     FROM handyman_requests
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByRequestNumber(
  clientId: string,
  requestNumber: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestRecord | null> {
  const result = await executor.query<HandymanRequestRecord>(
    `SELECT ${HANDYMAN_REQUEST_SELECT}
     FROM handyman_requests
     WHERE client_id = $1 AND request_number = $2`,
    [clientId, requestNumber],
  );
  return result.rows[0] ?? null;
}

async function findByIdempotencyKey(
  clientId: string,
  idempotencyKey: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestRecord | null> {
  const result = await executor.query<HandymanRequestRecord>(
    `SELECT ${HANDYMAN_REQUEST_SELECT}
     FROM handyman_requests
     WHERE client_id = $1 AND idempotency_key = $2`,
    [clientId, idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function create(
  input: CreateHandymanRequestRecordInput,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<{ record: HandymanRequestRecord; created: boolean }> {
  const id = input.id ?? randomUUID();
  const operationalSurface = input.operationalSurface ?? 'BM_SUPER_APP';
  const priority = input.priority ?? 'MEDIUM';
  const status = input.status ?? 'SUBMITTED';
  const requestedAt = input.requestedAt ?? new Date();

  if (input.idempotencyKey) {
    const result = await executor.query<HandymanRequestRecord>(
      `INSERT INTO handyman_requests
         (id, client_id, building_id, space_id, tenant_company_id, tenant_pic_id,
          customer_name, customer_phone, customer_email, created_by_user_id,
          operational_surface, inbound_channel, request_number, title, description,
          priority, status, idempotency_key, idempotency_fingerprint, requested_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
       ON CONFLICT (client_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING ${HANDYMAN_REQUEST_SELECT}`,
      [
        id,
        input.clientId,
        input.buildingId,
        input.spaceId,
        input.tenantCompanyId ?? null,
        input.tenantPicId ?? null,
        input.customerName,
        input.customerPhone ?? null,
        input.customerEmail ?? null,
        input.createdByUserId,
        operationalSurface,
        input.inboundChannel,
        input.requestNumber,
        input.title,
        input.description ?? null,
        priority,
        status,
        input.idempotencyKey,
        input.idempotencyFingerprint ?? null,
        requestedAt,
      ],
    );

    if (result.rows[0]) {
      return { record: result.rows[0], created: true };
    }

    const existing = await findByIdempotencyKey(
      input.clientId,
      input.idempotencyKey,
      executor,
    );
    if (!existing) {
      throw new Error('Handyman request idempotency conflict could not be resolved.');
    }
    return { record: existing, created: false };
  }

  const result = await executor.query<HandymanRequestRecord>(
    `INSERT INTO handyman_requests
       (id, client_id, building_id, space_id, tenant_company_id, tenant_pic_id,
        customer_name, customer_phone, customer_email, created_by_user_id,
        operational_surface, inbound_channel, request_number, title, description,
        priority, status, idempotency_key, idempotency_fingerprint, requested_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING ${HANDYMAN_REQUEST_SELECT}`,
    [
      id,
      input.clientId,
      input.buildingId,
      input.spaceId,
      input.tenantCompanyId ?? null,
      input.tenantPicId ?? null,
      input.customerName,
      input.customerPhone ?? null,
      input.customerEmail ?? null,
      input.createdByUserId,
      operationalSurface,
      input.inboundChannel,
      input.requestNumber,
      input.title,
      input.description ?? null,
      priority,
      status,
      null,
      null,
      requestedAt,
    ],
  );

  return { record: result.rows[0], created: true };
}

async function list(
  filters: HandymanRequestFilters,
  accessibleBuildingIds?: string[],
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestRecord[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  if (accessibleBuildingIds !== undefined) {
    if (accessibleBuildingIds.length === 0) return [];
    values.push(accessibleBuildingIds);
    clauses.push(`building_id = ANY($${values.length}::uuid[])`);
  }

  if (filters.buildingId) {
    values.push(filters.buildingId);
    clauses.push(`building_id = $${values.length}`);
  }

  if (filters.spaceId) {
    values.push(filters.spaceId);
    clauses.push(`space_id = $${values.length}`);
  }

  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }

  if (filters.inboundChannel) {
    values.push(filters.inboundChannel);
    clauses.push(`inbound_channel = $${values.length}`);
  }

  if (filters.createdByUserId) {
    values.push(filters.createdByUserId);
    clauses.push(`created_by_user_id = $${values.length}`);
  }

  if (filters.tenantCompanyId) {
    values.push(filters.tenantCompanyId);
    clauses.push(`tenant_company_id = $${values.length}`);
  }

  if (filters.search) {
    values.push(`%${filters.search.trim()}%`);
    clauses.push(
      `(title ILIKE $${values.length} OR request_number ILIKE $${values.length} OR customer_name ILIKE $${values.length})`,
    );
  }

  const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  let pagination = '';
  if (filters.limit !== undefined) {
    values.push(filters.limit);
    pagination += ` LIMIT $${values.length}`;
  }
  if (filters.offset !== undefined) {
    values.push(filters.offset);
    pagination += ` OFFSET $${values.length}`;
  }

  const result = await executor.query<HandymanRequestRecord>(
    `SELECT ${HANDYMAN_REQUEST_SELECT}
     FROM handyman_requests
     ${whereClause}
     ORDER BY requested_at DESC, created_at DESC
     ${pagination}`,
    values,
  );
  return result.rows;
}

async function updateStatus(
  id: string,
  status: HandymanRequestStatus,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanRequestRecord | null> {
  const result = await executor.query<HandymanRequestRecord>(
    `UPDATE handyman_requests
     SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${HANDYMAN_REQUEST_SELECT}`,
    [id, status],
  );
  return result.rows[0] ?? null;
}

export const handymanRequestRepository = {
  create,
  findById,
  findByIdempotencyKey,
  findByRequestNumber,
  list,
  updateStatus,
};

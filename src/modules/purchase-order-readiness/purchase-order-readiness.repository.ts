import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewPOReadiness,
  POReadinessFilters,
  POReadinessRecord,
  POReadinessStatus,
  UpdatePOReadinessInput,
} from './purchase-order-readiness.types';

type POReadinessRow = {
  id: string;
  clientId: string;
  buildingId: string;
  requestType: string;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  vendorId: string;
  materialContextOk: boolean;
  serviceContextOk: boolean;
  approvalOk: boolean;
  vendorOk: boolean;
  readiness: string;
  requiredDate: Date | null;
  notes: string | null;
  preparedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `id, client_id AS "clientId", building_id AS "buildingId",
  request_type AS "requestType", purchase_request_id AS "purchaseRequestId",
  service_request_id AS "serviceRequestId", vendor_id AS "vendorId",
  material_context_ok AS "materialContextOk",
  service_context_ok AS "serviceContextOk", approval_ok AS "approvalOk",
  vendor_ok AS "vendorOk", readiness, required_date AS "requiredDate",
  notes, prepared_by_user_id AS "preparedByUserId",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

function mapRow(row: POReadinessRow): POReadinessRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    requestType: row.requestType as POReadinessRecord['requestType'],
    purchaseRequestId: row.purchaseRequestId,
    serviceRequestId: row.serviceRequestId,
    vendorId: row.vendorId,
    materialContextOk: row.materialContextOk,
    serviceContextOk: row.serviceContextOk,
    approvalOk: row.approvalOk,
    vendorOk: row.vendorOk,
    readiness: row.readiness as POReadinessRecord['readiness'],
    requiredDate: row.requiredDate,
    notes: row.notes,
    preparedByUserId: row.preparedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(input: NewPOReadiness): Promise<POReadinessRecord> {
  const result = await getPool().query<POReadinessRow>(
    `INSERT INTO purchase_order_readiness
       (id, client_id, building_id, request_type, purchase_request_id,
        service_request_id, vendor_id, material_context_ok, service_context_ok,
        approval_ok, vendor_ok, readiness, required_date, notes,
        prepared_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.requestType,
      input.purchaseRequestId,
      input.serviceRequestId,
      input.vendorId,
      input.materialContextOk,
      input.serviceContextOk,
      input.approvalOk,
      input.vendorOk,
      input.readiness,
      input.requiredDate,
      input.notes,
      input.preparedByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<POReadinessRecord | null> {
  const result = await getPool().query<POReadinessRow>(
    `SELECT ${SELECT} FROM purchase_order_readiness WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findByIdWithDetails(
  id: string,
): Promise<Record<string, unknown> | null> {
  const result = await getPool().query(
    `SELECT
       r.id, r.client_id AS "clientId", r.building_id AS "buildingId",
       r.request_type AS "requestType",
       r.purchase_request_id AS "purchaseRequestId",
       r.service_request_id AS "serviceRequestId",
       r.vendor_id AS "vendorId",
       r.material_context_ok AS "materialContextOk",
       r.service_context_ok AS "serviceContextOk",
       r.approval_ok AS "approvalOk", r.vendor_ok AS "vendorOk",
       r.readiness, r.required_date AS "requiredDate", r.notes,
       r.prepared_by_user_id AS "preparedByUserId",
       r.created_at AS "createdAt", r.updated_at AS "updatedAt",
       v.vendor_code AS "vendorCode", v.vendor_name AS "vendorName", v.status AS "vendorStatus",
       pr.request_number AS "prNumber", pr.title AS "prTitle", pr.status AS "prStatus",
       sr.service_type AS "srServiceType", sr.title AS "srTitle", sr.status AS "srStatus"
     FROM purchase_order_readiness r
     LEFT JOIN vendors v ON v.id = r.vendor_id
     LEFT JOIN purchase_requests pr ON pr.id = r.purchase_request_id
     LEFT JOIN service_requests sr ON sr.id = r.service_request_id
     WHERE r.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findExisting(
  vendorId: string,
  purchaseRequestId: string | null,
  serviceRequestId: string | null,
): Promise<POReadinessRecord | null> {
  const result = await getPool().query<POReadinessRow>(
    `SELECT ${SELECT} FROM purchase_order_readiness
     WHERE vendor_id = $1 AND purchase_request_id IS NOT DISTINCT FROM $2
       AND service_request_id IS NOT DISTINCT FROM $3`,
    [vendorId, purchaseRequestId, serviceRequestId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findExistingForRequest(
  purchaseRequestId: string | null,
  serviceRequestId: string | null,
): Promise<POReadinessRecord | null> {
  const result = await getPool().query<POReadinessRow>(
    `SELECT ${SELECT} FROM purchase_order_readiness
     WHERE purchase_request_id IS NOT DISTINCT FROM $1
       AND service_request_id IS NOT DISTINCT FROM $2
       AND readiness = 'READY'
     ORDER BY created_at DESC LIMIT 1`,
    [purchaseRequestId, serviceRequestId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function listByRequest(
  purchaseRequestId: string | null,
  serviceRequestId: string | null,
  buildingId: string,
  filters: POReadinessFilters,
): Promise<POReadinessRecord[]> {
  const conditions: string[] = ['building_id = $1'];
  const values: unknown[] = [buildingId];
  if (purchaseRequestId) {
    values.push(purchaseRequestId);
    conditions.push(`purchase_request_id = $${values.length}`);
  }
  if (serviceRequestId) {
    values.push(serviceRequestId);
    conditions.push(`service_request_id = $${values.length}`);
  }
  if (filters.readiness !== undefined) {
    values.push(filters.readiness);
    conditions.push(`readiness = $${values.length}`);
  }
  const result = await getPool().query<POReadinessRow>(
    `SELECT ${SELECT} FROM purchase_order_readiness
     WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function listByVendor(
  vendorId: string,
  buildingIds: string[],
  filters: POReadinessFilters,
): Promise<POReadinessRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [vendorId, buildingIds];
  const conditions = ['vendor_id = $1', 'building_id = ANY($2::uuid[])'];
  if (filters.readiness !== undefined) {
    values.push(filters.readiness);
    conditions.push(`readiness = $${values.length}`);
  }
  const result = await getPool().query<POReadinessRow>(
    `SELECT ${SELECT} FROM purchase_order_readiness
     WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function listByBuilding(
  buildingId: string,
  filters: POReadinessFilters,
): Promise<POReadinessRecord[]> {
  const conditions: string[] = ['building_id = $1'];
  const values: unknown[] = [buildingId];
  if (filters.readiness !== undefined) {
    values.push(filters.readiness);
    conditions.push(`readiness = $${values.length}`);
  }
  const result = await getPool().query<POReadinessRow>(
    `SELECT ${SELECT} FROM purchase_order_readiness
     WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function update(
  id: string,
  input: UpdatePOReadinessInput,
): Promise<POReadinessRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.requiredDate !== undefined) {
    values.push(input.requiredDate);
    sets.push(`required_date = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<POReadinessRow>(
    `UPDATE purchase_order_readiness SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const poReadinessRepository = {
  create,
  findById,
  findByIdWithDetails,
  findExisting,
  findExistingForRequest,
  listByBuilding,
  listByRequest,
  listByVendor,
  update,
};

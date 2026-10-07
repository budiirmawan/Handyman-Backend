import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewServiceRequest,
  ServiceRequestFilters,
  ServiceRequestRecord,
  ServiceRequestStatus,
  UpdateServiceRequestInput,
} from './service-request.types';

type ServiceRequestRow = {
  id: string;
  clientId: string;
  buildingId: string;
  purchaseRequestId: string;
  serviceType: string;
  title: string;
  description: string | null;
  requiredDate: Date | null;
  functionalLocationId: string | null;
  vendorId: string | null;
  serviceCatalogId: string | null;
  notes: string | null;
  status: ServiceRequestStatus;
  requestedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const SERVICE_REQUEST_SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  purchase_request_id AS "purchaseRequestId",
  service_type AS "serviceType",
  title,
  description,
  required_date AS "requiredDate",
  functional_location_id AS "functionalLocationId",
  vendor_id AS "vendorId",
  service_catalog_id AS "serviceCatalogId",
  notes,
  status,
  requested_by_user_id AS "requestedByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: ServiceRequestRow): ServiceRequestRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    purchaseRequestId: row.purchaseRequestId,
    serviceType: row.serviceType,
    title: row.title,
    description: row.description,
    requiredDate: row.requiredDate,
    functionalLocationId: row.functionalLocationId,
    vendorId: row.vendorId,
    serviceCatalogId: row.serviceCatalogId,
    notes: row.notes,
    status: row.status,
    requestedByUserId: row.requestedByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(input: NewServiceRequest): Promise<ServiceRequestRecord> {
  const result = await getPool().query<ServiceRequestRow>(
    `INSERT INTO service_requests
       (id, client_id, building_id, purchase_request_id, service_type, title,
        description, required_date, functional_location_id, vendor_id,
        service_catalog_id, notes, status, requested_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'OPEN', $13)
     RETURNING ${SERVICE_REQUEST_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.purchaseRequestId,
      input.serviceType,
      input.title,
      input.description,
      input.requiredDate,
      input.functionalLocationId,
      input.vendorId,
      input.serviceCatalogId,
      input.notes,
      input.requestedByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<ServiceRequestRecord | null> {
  const result = await getPool().query<ServiceRequestRow>(
    `SELECT ${SERVICE_REQUEST_SELECT} FROM service_requests WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByIdWithDetails(id: string): Promise<Record<string, unknown> | null> {
  const result = await getPool().query(
    `SELECT
       sr.id,
       sr.client_id AS "clientId",
       sr.building_id AS "buildingId",
       sr.purchase_request_id AS "purchaseRequestId",
       sr.service_type AS "serviceType",
       sr.title,
       sr.description,
       sr.required_date AS "requiredDate",
       sr.functional_location_id AS "functionalLocationId",
       sr.vendor_id AS "vendorId",
       sr.service_catalog_id AS "serviceCatalogId",
       sr.notes,
       sr.status,
       sr.requested_by_user_id AS "requestedByUserId",
       sr.created_at AS "createdAt",
       sr.updated_at AS "updatedAt",
       pr.request_number AS "purchaseRequestNumber",
       pr.title AS "purchaseRequestTitle",
       pr.status AS "purchaseRequestStatus",
       fl.code AS "locationCode",
       fl.name AS "locationName",
       fl.building_id AS "locationBuildingId"
     FROM service_requests sr
     LEFT JOIN purchase_requests pr ON pr.id = sr.purchase_request_id
     LEFT JOIN functional_locations fl ON fl.id = sr.functional_location_id
     WHERE sr.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listByBuilding(
  buildingId: string,
  filters: ServiceRequestFilters,
): Promise<ServiceRequestRecord[]> {
  const conditions: string[] = ['building_id = $1'];
  const values: unknown[] = [buildingId];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.purchaseRequestId !== undefined) {
    values.push(filters.purchaseRequestId);
    conditions.push(`purchase_request_id = $${values.length}`);
  }
  if (filters.serviceType !== undefined) {
    values.push(filters.serviceType);
    conditions.push(`service_type = $${values.length}`);
  }

  const result = await getPool().query<ServiceRequestRow>(
    `SELECT ${SERVICE_REQUEST_SELECT} FROM service_requests
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function listByPurchaseRequest(
  purchaseRequestId: string,
  filters: ServiceRequestFilters,
): Promise<ServiceRequestRecord[]> {
  const conditions: string[] = ['purchase_request_id = $1'];
  const values: unknown[] = [purchaseRequestId];

  if (filters.status !== undefined) {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.serviceType !== undefined) {
    values.push(filters.serviceType);
    conditions.push(`service_type = $${values.length}`);
  }

  const result = await getPool().query<ServiceRequestRow>(
    `SELECT ${SERVICE_REQUEST_SELECT} FROM service_requests
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );

  return result.rows.map(mapRow);
}

async function update(
  id: string,
  input: UpdateServiceRequestInput,
): Promise<ServiceRequestRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.serviceType !== undefined) {
    values.push(input.serviceType);
    sets.push(`service_type = $${values.length}`);
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
  if (input.functionalLocationId !== undefined) {
    values.push(input.functionalLocationId);
    sets.push(`functional_location_id = $${values.length}`);
  }
  if (input.vendorId !== undefined) {
    values.push(input.vendorId);
    sets.push(`vendor_id = $${values.length}`);
  }
  if (input.serviceCatalogId !== undefined) {
    values.push(input.serviceCatalogId);
    sets.push(`service_catalog_id = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push('updated_at = NOW()');

  const result = await getPool().query<ServiceRequestRow>(
    `UPDATE service_requests SET ${sets.join(', ')}
     WHERE id = $${values.length}
     RETURNING ${SERVICE_REQUEST_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  id: string,
  status: ServiceRequestStatus,
): Promise<ServiceRequestRecord | null> {
  const result = await getPool().query<ServiceRequestRow>(
    `UPDATE service_requests SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${SERVICE_REQUEST_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const serviceRequestRepository = {
  create,
  findById,
  findByIdWithDetails,
  listByBuilding,
  listByPurchaseRequest,
  update,
  updateStatus,
};

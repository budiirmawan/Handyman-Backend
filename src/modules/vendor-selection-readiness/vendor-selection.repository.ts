import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorSelection,
  VendorSelectionFilters,
  VendorSelectionRecord,
} from './vendor-selection.types';

type VendorSelectionRow = {
  id: string;
  clientId: string;
  buildingId: string;
  requestType: string;
  purchaseRequestId: string | null;
  serviceRequestId: string | null;
  vendorId: string;
  serviceType: string;
  serviceCatalogId: string | null;
  vendorActive: boolean;
  buildingRelationshipOk: boolean;
  capabilityMatch: boolean;
  complianceOk: boolean;
  licenseOk: boolean;
  approvalOk: boolean;
  readiness: string;
  notes: string | null;
  evaluatedByUserId: string;
  evaluatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const SELECT = `id, client_id AS "clientId", building_id AS "buildingId",
  request_type AS "requestType", purchase_request_id AS "purchaseRequestId",
  service_request_id AS "serviceRequestId", vendor_id AS "vendorId",
  service_type AS "serviceType", service_catalog_id AS "serviceCatalogId",
  vendor_active AS "vendorActive",
  building_relationship_ok AS "buildingRelationshipOk",
  capability_match AS "capabilityMatch", compliance_ok AS "complianceOk",
  license_ok AS "licenseOk", approval_ok AS "approvalOk",
  readiness, notes, evaluated_by_user_id AS "evaluatedByUserId",
  evaluated_at AS "evaluatedAt", created_at AS "createdAt",
  updated_at AS "updatedAt"`;

function mapRow(row: VendorSelectionRow): VendorSelectionRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    requestType: row.requestType as VendorSelectionRecord['requestType'],
    purchaseRequestId: row.purchaseRequestId,
    serviceRequestId: row.serviceRequestId,
    vendorId: row.vendorId,
    serviceType: row.serviceType,
    serviceCatalogId: row.serviceCatalogId,
    vendorActive: row.vendorActive,
    buildingRelationshipOk: row.buildingRelationshipOk,
    capabilityMatch: row.capabilityMatch,
    complianceOk: row.complianceOk,
    licenseOk: row.licenseOk,
    approvalOk: row.approvalOk,
    readiness: row.readiness as VendorSelectionRecord['readiness'],
    notes: row.notes,
    evaluatedByUserId: row.evaluatedByUserId,
    evaluatedAt: row.evaluatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewVendorSelection,
): Promise<VendorSelectionRecord> {
  const result = await getPool().query<VendorSelectionRow>(
    `INSERT INTO vendor_selection_readiness
       (id, client_id, building_id, request_type, purchase_request_id,
        service_request_id, vendor_id, service_type, service_catalog_id,
        vendor_active, building_relationship_ok, capability_match,
        compliance_ok, license_ok, approval_ok, readiness, notes,
        evaluated_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.requestType,
      input.purchaseRequestId,
      input.serviceRequestId,
      input.vendorId,
      input.serviceType,
      input.serviceCatalogId,
      input.vendorActive,
      input.buildingRelationshipOk,
      input.capabilityMatch,
      input.complianceOk,
      input.licenseOk,
      input.approvalOk,
      input.readiness,
      input.notes,
      input.evaluatedByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorSelectionRecord | null> {
  const result = await getPool().query<VendorSelectionRow>(
    `SELECT ${SELECT} FROM vendor_selection_readiness WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findExisting(
  vendorId: string,
  purchaseRequestId: string | null,
  serviceRequestId: string | null,
): Promise<VendorSelectionRecord | null> {
  const result = await getPool().query<VendorSelectionRow>(
    `SELECT ${SELECT} FROM vendor_selection_readiness
     WHERE vendor_id = $1 AND purchase_request_id IS NOT DISTINCT FROM $2
       AND service_request_id IS NOT DISTINCT FROM $3`,
    [vendorId, purchaseRequestId, serviceRequestId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function listByRequest(
  purchaseRequestId: string | null,
  serviceRequestId: string | null,
  buildingId: string,
  filters: VendorSelectionFilters,
): Promise<VendorSelectionRecord[]> {
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
  const result = await getPool().query<VendorSelectionRow>(
    `SELECT ${SELECT} FROM vendor_selection_readiness
     WHERE ${conditions.join(' AND ')} ORDER BY evaluated_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function listByVendor(
  vendorId: string,
  buildingIds: string[],
  filters: VendorSelectionFilters,
): Promise<VendorSelectionRecord[]> {
  if (buildingIds.length === 0) return [];
  const values: unknown[] = [vendorId, buildingIds];
  const conditions = ['vendor_id = $1', 'building_id = ANY($2::uuid[])'];
  if (filters.readiness !== undefined) {
    values.push(filters.readiness);
    conditions.push(`readiness = $${values.length}`);
  }
  const result = await getPool().query<VendorSelectionRow>(
    `SELECT ${SELECT} FROM vendor_selection_readiness
     WHERE ${conditions.join(' AND ')} ORDER BY evaluated_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

async function findByIdWithDetails(
  id: string,
): Promise<Record<string, unknown> | null> {
  const result = await getPool().query(
    `SELECT
       vs.id,
       vs.client_id AS "clientId", vs.building_id AS "buildingId",
       vs.request_type AS "requestType",
       vs.purchase_request_id AS "purchaseRequestId",
       vs.service_request_id AS "serviceRequestId",
       vs.vendor_id AS "vendorId", vs.service_type AS "serviceType",
       vs.service_catalog_id AS "serviceCatalogId",
       vs.vendor_active AS "vendorActive",
       vs.building_relationship_ok AS "buildingRelationshipOk",
       vs.capability_match AS "capabilityMatch",
       vs.compliance_ok AS "complianceOk", vs.license_ok AS "licenseOk",
       vs.approval_ok AS "approvalOk", vs.readiness,
       vs.notes, vs.evaluated_by_user_id AS "evaluatedByUserId",
       vs.evaluated_at AS "evaluatedAt", vs.created_at AS "createdAt",
       vs.updated_at AS "updatedAt",
       v.vendor_code AS "vendorCode", v.vendor_name AS "vendorName", v.status AS "vendorStatus",
       pr.request_number AS "prNumber", pr.title AS "prTitle", pr.status AS "prStatus",
       sr.service_type AS "srServiceType", sr.title AS "srTitle", sr.status AS "srStatus"
     FROM vendor_selection_readiness vs
     LEFT JOIN vendors v ON v.id = vs.vendor_id
     LEFT JOIN purchase_requests pr ON pr.id = vs.purchase_request_id
     LEFT JOIN service_requests sr ON sr.id = vs.service_request_id
     WHERE vs.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const vendorSelectionRepository = {
  create,
  findById,
  findByIdWithDetails,
  findExisting,
  listByRequest,
  listByVendor,
};

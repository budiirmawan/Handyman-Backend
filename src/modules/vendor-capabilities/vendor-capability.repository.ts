import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorCapability,
  UpdateVendorCapabilityInput,
  VendorCapabilityRecord,
  VendorCapabilityStatus,
} from './vendor-capability.types';

type VendorCapabilityRow = {
  id: string;
  vendorId: string;
  code: string;
  name: string;
  description: string | null;
  vendorBuildingRelationshipId: string | null;
  serviceCatalogId: string | null;
  status: VendorCapabilityStatus;
  createdAt: Date;
  updatedAt: Date;
};

const VENDOR_CAPABILITY_SELECT = `
  id,
  vendor_id AS "vendorId",
  code,
  name,
  description,
  vendor_building_relationship_id AS "vendorBuildingRelationshipId",
  service_catalog_id AS "serviceCatalogId",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: VendorCapabilityRow): VendorCapabilityRecord {
  return {
    id: row.id,
    vendorId: row.vendorId,
    code: row.code,
    name: row.name,
    description: row.description,
    vendorBuildingRelationshipId: row.vendorBuildingRelationshipId,
    serviceCatalogId: row.serviceCatalogId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createVendorCapability(
  input: NewVendorCapability,
): Promise<VendorCapabilityRecord> {
  const result = await getPool().query<VendorCapabilityRow>(
    `INSERT INTO vendor_capabilities
       (id, vendor_id, code, name, description,
        vendor_building_relationship_id, service_catalog_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${VENDOR_CAPABILITY_SELECT}`,
    [
      randomUUID(),
      input.vendorId,
      input.code,
      input.name,
      input.description,
      input.vendorBuildingRelationshipId,
      input.serviceCatalogId,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorCapabilityRecord | null> {
  const result = await getPool().query<VendorCapabilityRow>(
    `SELECT ${VENDOR_CAPABILITY_SELECT} FROM vendor_capabilities WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByCodeForVendor(
  vendorId: string,
  code: string,
): Promise<VendorCapabilityRecord | null> {
  const result = await getPool().query<VendorCapabilityRow>(
    `SELECT ${VENDOR_CAPABILITY_SELECT} FROM vendor_capabilities
     WHERE vendor_id = $1 AND code = $2`,
    [vendorId, code],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function listByVendor(
  vendorId: string,
): Promise<VendorCapabilityRecord[]> {
  const result = await getPool().query<VendorCapabilityRow>(
    `SELECT ${VENDOR_CAPABILITY_SELECT} FROM vendor_capabilities
     WHERE vendor_id = $1 ORDER BY code ASC`,
    [vendorId],
  );

  return result.rows.map(mapRow);
}

async function updateVendorCapability(
  id: string,
  input: UpdateVendorCapabilityInput,
): Promise<VendorCapabilityRecord | null> {
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
  if (input.vendorBuildingRelationshipId !== undefined) {
    values.push(input.vendorBuildingRelationshipId);
    sets.push(`vendor_building_relationship_id = $${values.length}`);
  }
  if (input.serviceCatalogId !== undefined) {
    values.push(input.serviceCatalogId);
    sets.push(`service_catalog_id = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<VendorCapabilityRow>(
    `UPDATE vendor_capabilities SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${VENDOR_CAPABILITY_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const vendorCapabilityRepository = {
  createVendorCapability,
  findByCodeForVendor,
  findById,
  listByVendor,
  updateVendorCapability,
};

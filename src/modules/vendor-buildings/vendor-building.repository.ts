import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorBuildingRelationship,
  UpdateVendorBuildingRelationshipInput,
  VendorBuildingRelationshipRecord,
  VendorBuildingRelationshipStatus,
} from './vendor-building.types';

type VendorBuildingRelationshipRow = {
  id: string;
  vendor_id: string;
  building_id: string;
  effective_from: Date | null;
  effective_until: Date | null;
  status: VendorBuildingRelationshipStatus;
  created_at: Date;
  updated_at: Date;
};

const RELATIONSHIP_SELECT = `
  id,
  vendor_id,
  building_id,
  effective_from,
  effective_until,
  status,
  created_at,
  updated_at
`;

function mapRow(
  row: VendorBuildingRelationshipRow,
): VendorBuildingRelationshipRecord {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    buildingId: row.building_id,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(
  input: NewVendorBuildingRelationship,
): Promise<VendorBuildingRelationshipRecord> {
  const result = await getPool().query<VendorBuildingRelationshipRow>(
    `INSERT INTO vendor_building_relationships
       (id, vendor_id, building_id, effective_from, effective_until, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${RELATIONSHIP_SELECT}`,
    [
      randomUUID(),
      input.vendorId,
      input.buildingId,
      input.effectiveFrom,
      input.effectiveUntil,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
): Promise<VendorBuildingRelationshipRecord | null> {
  const result = await getPool().query<VendorBuildingRelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} FROM vendor_building_relationships
     WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Every Building relationship held by one Vendor, history included. */
async function listByVendorId(
  vendorId: string,
): Promise<VendorBuildingRelationshipRecord[]> {
  const result = await getPool().query<VendorBuildingRelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} FROM vendor_building_relationships
     WHERE vendor_id = $1
     ORDER BY created_at ASC`,
    [vendorId],
  );

  return result.rows.map(mapRow);
}

/** Every Vendor relationship held by one Building, history included. */
async function listByBuildingId(
  buildingId: string,
): Promise<VendorBuildingRelationshipRecord[]> {
  const result = await getPool().query<VendorBuildingRelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} FROM vendor_building_relationships
     WHERE building_id = $1
     ORDER BY created_at ASC`,
    [buildingId],
  );

  return result.rows.map(mapRow);
}

/**
 * Resolves the relationship addressed by the API route
 * (`/vendors/:vendorId/buildings/:buildingId`). Prefers the ACTIVE row so an
 * update targets the live relationship rather than deactivated history.
 */
async function findByVendorAndBuilding(
  vendorId: string,
  buildingId: string,
): Promise<VendorBuildingRelationshipRecord | null> {
  const result = await getPool().query<VendorBuildingRelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} FROM vendor_building_relationships
     WHERE vendor_id = $1 AND building_id = $2
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC
     LIMIT 1`,
    [vendorId, buildingId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByVendorAndBuilding(
  vendorId: string,
  buildingId: string,
): Promise<VendorBuildingRelationshipRecord | null> {
  const result = await getPool().query<VendorBuildingRelationshipRow>(
    `SELECT ${RELATIONSHIP_SELECT} FROM vendor_building_relationships
     WHERE vendor_id = $1 AND building_id = $2 AND status = 'ACTIVE'`,
    [vendorId, buildingId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function update(
  id: string,
  input: UpdateVendorBuildingRelationshipInput,
): Promise<VendorBuildingRelationshipRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.effectiveFrom !== undefined) {
    values.push(input.effectiveFrom);
    sets.push(`effective_from = $${values.length}`);
  }
  if (input.effectiveUntil !== undefined) {
    values.push(input.effectiveUntil);
    sets.push(`effective_until = $${values.length}`);
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

  const result = await getPool().query<VendorBuildingRelationshipRow>(
    `UPDATE vendor_building_relationships SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${RELATIONSHIP_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const vendorBuildingRepository = {
  create,
  findActiveByVendorAndBuilding,
  findById,
  findByVendorAndBuilding,
  listByBuildingId,
  listByVendorId,
  update,
};

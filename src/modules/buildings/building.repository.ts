import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  BuildingRecord,
  BuildingStatus,
  NewBuilding,
} from './building.types';

type BuildingRow = {
  id: string;
  propertyId: string;
  campusId: string | null;
  code: string;
  name: string;
  description: string | null;
  status: BuildingStatus;
  addressLine: string | null;
  city: string | null;
  province: string | null;
  postalCode: string | null;
  countryCode: string | null;
  timezone: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const BUILDING_SELECT = `
  id,
  property_id AS "propertyId",
  campus_id AS "campusId",
  code,
  name,
  description,
  status,
  address_line AS "addressLine",
  city,
  province,
  postal_code AS "postalCode",
  country_code AS "countryCode",
  timezone,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapBuildingRow(row: BuildingRow): BuildingRecord {
  return {
    id: row.id,
    propertyId: row.propertyId,
    campusId: row.campusId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    addressLine: row.addressLine,
    city: row.city,
    province: row.province,
    postalCode: row.postalCode,
    countryCode: row.countryCode,
    timezone: row.timezone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createBuilding(input: NewBuilding): Promise<BuildingRecord> {
  const result = await getPool().query<BuildingRow>(
    `INSERT INTO buildings
       (id, property_id, code, name, description, status,
        address_line, city, province, postal_code, country_code, timezone)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${BUILDING_SELECT}`,
    [
      randomUUID(),
      input.propertyId,
      input.code,
      input.name,
      input.description,
      input.status,
      input.addressLine,
      input.city,
      input.province,
      input.postalCode,
      input.countryCode,
      input.timezone,
    ],
  );

  return mapBuildingRow(result.rows[0]);
}

async function findById(id: string): Promise<BuildingRecord | null> {
  const result = await getPool().query<BuildingRow>(
    `SELECT ${BUILDING_SELECT} FROM buildings WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapBuildingRow(row) : null;
}

async function findByCodeForProperty(
  propertyId: string,
  code: string,
): Promise<BuildingRecord | null> {
  const result = await getPool().query<BuildingRow>(
    `SELECT ${BUILDING_SELECT} FROM buildings
     WHERE property_id = $1 AND code = $2`,
    [propertyId, code],
  );

  const row = result.rows[0];
  return row ? mapBuildingRow(row) : null;
}

async function listBuildings(): Promise<BuildingRecord[]> {
  const result = await getPool().query<BuildingRow>(
    `SELECT ${BUILDING_SELECT} FROM buildings ORDER BY code ASC`,
  );

  return result.rows.map(mapBuildingRow);
}

async function listByProperty(propertyId: string): Promise<BuildingRecord[]> {
  const result = await getPool().query<BuildingRow>(
    `SELECT ${BUILDING_SELECT} FROM buildings
     WHERE property_id = $1 ORDER BY code ASC`,
    [propertyId],
  );

  return result.rows.map(mapBuildingRow);
}

async function updateStatus(
  id: string,
  status: BuildingStatus,
): Promise<BuildingRecord | null> {
  const result = await getPool().query<BuildingRow>(
    `UPDATE buildings SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${BUILDING_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapBuildingRow(row) : null;
}

async function updateCampusReference(
  id: string,
  campusId: string | null,
): Promise<BuildingRecord | null> {
  const result = await getPool().query<BuildingRow>(
    `UPDATE buildings SET campus_id = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${BUILDING_SELECT}`,
    [id, campusId],
  );

  const row = result.rows[0];
  return row ? mapBuildingRow(row) : null;
}

export const buildingRepository = {
  createBuilding,
  updateCampusReference,
  findByCodeForProperty,
  findById,
  listBuildings,
  listByProperty,
  updateStatus,
};

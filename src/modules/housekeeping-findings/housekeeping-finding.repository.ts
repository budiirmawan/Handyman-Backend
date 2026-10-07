import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HousekeepingFindingFilter,
  HousekeepingFindingLinkRecord,
  HousekeepingFindingSourceType,
} from './housekeeping-finding.types';

type HousekeepingFindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  finding_id: string;
  cleaning_area_id: string;
  source_type: HousekeepingFindingSourceType;
  source_id: string;
  floor_id: string | null;
  area_id: string | null;
  room_id: string | null;
  functional_location_id: string | null;
  notes: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type HousekeepingFindingWithFindingRow = HousekeepingFindingRow & {
  finding_number: string;
  finding_title: string;
  finding_description: string | null;
  finding_status: string;
  finding_reported_by_user_id: string;
  finding_reported_at: Date;
};

function mapRow(row: HousekeepingFindingRow): HousekeepingFindingLinkRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    findingId: row.finding_id,
    cleaningAreaId: row.cleaning_area_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    floorId: row.floor_id,
    areaId: row.area_id,
    roomId: row.room_id,
    functionalLocationId: row.functional_location_id,
    notes: row.notes,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(input: {
  clientId: string;
  buildingId: string;
  findingId: string;
  cleaningAreaId: string;
  sourceType: HousekeepingFindingSourceType;
  sourceId: string;
  floorId?: string | null;
  areaId?: string | null;
  roomId?: string | null;
  functionalLocationId?: string | null;
  notes?: string | null;
  createdByUserId: string;
}): Promise<HousekeepingFindingLinkRecord> {
  const result = await getPool().query<HousekeepingFindingRow>(
    `INSERT INTO housekeeping_finding_links
       (id, client_id, building_id, finding_id, cleaning_area_id,
        source_type, source_id, floor_id, area_id, room_id,
        functional_location_id, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, client_id, building_id, finding_id, cleaning_area_id,
               source_type, source_id, floor_id, area_id, room_id,
               functional_location_id, notes, created_by_user_id,
               created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.findingId,
      input.cleaningAreaId,
      input.sourceType,
      input.sourceId,
      input.floorId ?? null,
      input.areaId ?? null,
      input.roomId ?? null,
      input.functionalLocationId ?? null,
      input.notes ?? null,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<HousekeepingFindingWithFindingRow | null> {
  const result = await getPool().query<HousekeepingFindingWithFindingRow>(
    `SELECT
       hfl.*,
       f.finding_number AS finding_number,
       f.title AS finding_title,
       f.description AS finding_description,
       f.status AS finding_status,
       f.reported_by_user_id AS finding_reported_by_user_id,
       f.reported_at AS finding_reported_at
     FROM housekeeping_finding_links hfl
     JOIN findings f ON f.id = hfl.finding_id
     WHERE hfl.id = $1 OR hfl.finding_id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findByFindingId(
  findingId: string,
): Promise<HousekeepingFindingLinkRecord | null> {
  const result = await getPool().query<HousekeepingFindingRow>(
    `SELECT * FROM housekeeping_finding_links WHERE finding_id = $1`,
    [findingId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function list(
  filter: HousekeepingFindingFilter = {},
): Promise<HousekeepingFindingWithFindingRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filter.buildingId) {
    values.push(filter.buildingId);
    conditions.push(`hfl.building_id = $${values.length}`);
  }

  if (filter.cleaningAreaId) {
    values.push(filter.cleaningAreaId);
    conditions.push(`hfl.cleaning_area_id = $${values.length}`);
  }

  if (filter.sourceType) {
    values.push(filter.sourceType);
    conditions.push(`hfl.source_type = $${values.length}`);
  }

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`f.status = $${values.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await getPool().query<HousekeepingFindingWithFindingRow>(
    `SELECT
       hfl.*,
       f.finding_number AS finding_number,
       f.title AS finding_title,
       f.description AS finding_description,
       f.status AS finding_status,
       f.reported_by_user_id AS finding_reported_by_user_id,
       f.reported_at AS finding_reported_at
     FROM housekeeping_finding_links hfl
     JOIN findings f ON f.id = hfl.finding_id
     ${whereClause}
     ORDER BY f.reported_at DESC`,
    values,
  );
  return result.rows;
}

export const housekeepingFindingRepository = {
  create,
  findByFindingId,
  findById,
  list,
};

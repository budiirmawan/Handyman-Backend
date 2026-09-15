import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  PermitWorkContextFilters,
  PermitWorkContextRecord,
  PersistPermitWorkContext,
} from './permit-work-context.types';

const SELECT = `
  wc.id,
  wc.permit_application_id AS "permitApplicationId",
  pa.permit_id AS "permitId",
  p.permit_number AS "permitReference",
  p.client_id AS "clientId",
  p.building_id AS "buildingId",
  pa.status AS "applicationStatus",
  wc.location_type AS "locationType",
  COALESCE(
    wc.building_id,
    wc.floor_id,
    wc.area_id,
    wc.room_id,
    wc.functional_location_id
  ) AS "locationId",
  COALESCE(lb.code, lf.code, la.code, lr.code, lfl.code) AS "locationCode",
  COALESCE(lb.name, lf.name, la.name, lr.name, lfl.name) AS "locationName",
  wc.building_id AS "buildingLocationId",
  wc.floor_id AS "floorId",
  wc.area_id AS "areaId",
  wc.room_id AS "roomId",
  wc.functional_location_id AS "functionalLocationId",
  wc.work_type AS "workType",
  COALESCE(wc.work_description, p.work_description) AS "workDescription",
  wc.work_description AS "workDescriptionOverride",
  wc.planned_start_at AS "plannedStartAt",
  wc.planned_end_at AS "plannedEndAt",
  wc.access_restriction_notes AS "accessRestrictionNotes",
  wc.created_by_user_id AS "createdByUserId",
  wc.updated_by_user_id AS "updatedByUserId",
  wc.created_at AS "createdAt",
  wc.updated_at AS "updatedAt"
`;

const JOINS = `
  FROM permit_work_contexts wc
  JOIN permit_applications pa ON pa.id = wc.permit_application_id
  JOIN permits p ON p.id = pa.permit_id
  LEFT JOIN buildings lb ON lb.id = wc.building_id
  LEFT JOIN floors lf ON lf.id = wc.floor_id
  LEFT JOIN areas la ON la.id = wc.area_id
  LEFT JOIN rooms lr ON lr.id = wc.room_id
  LEFT JOIN functional_locations lfl ON lfl.id = wc.functional_location_id
`;

async function saveDraft(
  input: PersistPermitWorkContext,
): Promise<PermitWorkContextRecord | null> {
  const id = randomUUID();
  const location = input.location;
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO permit_work_contexts
       (id, permit_application_id, location_type, building_id, floor_id,
        area_id, room_id, functional_location_id, work_type,
        work_description, planned_start_at, planned_end_at,
        access_restriction_notes, created_by_user_id, updated_by_user_id)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14
     FROM permit_applications pa
     WHERE pa.id = $2 AND pa.status = 'DRAFT'
     ON CONFLICT (permit_application_id) DO UPDATE SET
       location_type = EXCLUDED.location_type,
       building_id = EXCLUDED.building_id,
       floor_id = EXCLUDED.floor_id,
       area_id = EXCLUDED.area_id,
       room_id = EXCLUDED.room_id,
       functional_location_id = EXCLUDED.functional_location_id,
       work_type = EXCLUDED.work_type,
       work_description = EXCLUDED.work_description,
       planned_start_at = EXCLUDED.planned_start_at,
       planned_end_at = EXCLUDED.planned_end_at,
       access_restriction_notes = EXCLUDED.access_restriction_notes,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = NOW()
     WHERE EXISTS (
       SELECT 1 FROM permit_applications current_application
       WHERE current_application.id = permit_work_contexts.permit_application_id
         AND current_application.status = 'DRAFT'
     )
     RETURNING id`,
    [
      id,
      input.permitApplicationId,
      location?.locationType ?? null,
      location?.buildingLocationId ?? null,
      location?.floorId ?? null,
      location?.areaId ?? null,
      location?.roomId ?? null,
      location?.functionalLocationId ?? null,
      input.workType,
      input.workDescription,
      input.plannedStartAt,
      input.plannedEndAt,
      input.accessRestrictionNotes,
      input.actorUserId,
    ],
  );
  const savedId = result.rows[0]?.id;
  return savedId ? findById(savedId) : null;
}

async function findById(id: string): Promise<PermitWorkContextRecord | null> {
  const result = await getPool().query<PermitWorkContextRecord>(
    `SELECT ${SELECT} ${JOINS} WHERE wc.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function findByApplicationId(
  permitApplicationId: string,
): Promise<PermitWorkContextRecord | null> {
  const result = await getPool().query<PermitWorkContextRecord>(
    `SELECT ${SELECT} ${JOINS} WHERE wc.permit_application_id = $1`,
    [permitApplicationId],
  );
  return result.rows[0] ?? null;
}

async function findByPermitId(
  permitId: string,
): Promise<PermitWorkContextRecord | null> {
  const result = await getPool().query<PermitWorkContextRecord>(
    `SELECT ${SELECT} ${JOINS} WHERE pa.permit_id = $1`,
    [permitId],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: PermitWorkContextFilters,
  accessibleBuildingIds: string[],
): Promise<PermitWorkContextRecord[]> {
  if (accessibleBuildingIds.length === 0) return [];
  const values: unknown[] = [accessibleBuildingIds];
  const conditions = ['p.building_id = ANY($1::uuid[])'];

  if (filters.buildingId) {
    values.push(filters.buildingId);
    conditions.push(`p.building_id = $${values.length}`);
  }
  if (filters.locationType) {
    values.push(filters.locationType);
    conditions.push(`wc.location_type = $${values.length}`);
  }
  if (filters.locationId) {
    values.push(filters.locationId);
    conditions.push(`$${values.length} IN (
      wc.building_id, wc.floor_id, wc.area_id, wc.room_id,
      wc.functional_location_id
    )`);
  }
  if (filters.workType) {
    values.push(filters.workType);
    conditions.push(`wc.work_type = $${values.length}`);
  }

  const result = await getPool().query<PermitWorkContextRecord>(
    `SELECT ${SELECT} ${JOINS}
     WHERE ${conditions.join(' AND ')}
     ORDER BY wc.created_at, wc.id`,
    values,
  );
  return result.rows;
}

export const permitWorkContextRepository = {
  findByApplicationId,
  findById,
  findByPermitId,
  list,
  saveDraft,
};

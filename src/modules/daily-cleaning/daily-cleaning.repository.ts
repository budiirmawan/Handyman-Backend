import { getPool } from '../../database';
import { dailyCleaningAreaAmbiguousError } from './daily-cleaning.errors';
import type {
  DailyCleaningFilter,
  DailyCleaningStatus,
} from './daily-cleaning.types';

export type DailyCleaningRow = {
  task_id: string;
  client_id: string;
  building_id: string;
  occurrence_at: Date;
  status: DailyCleaningStatus;
  started_at: Date | null;
  completed_at: Date | null;
  completed_by_user_id: string | null;
  completion_notes: string | null;
  created_at: Date;
  updated_at: Date;
  schedule_binding_id: string;
  schedule_definition_id: string;
  cleaning_area_id: string;
  cleaning_area_code: string;
  cleaning_area_name: string;
  cleaning_area_type: string;
  cleaning_area_status: string;
  floor_id: string | null;
  area_id: string | null;
  room_id: string | null;
  space_id: string | null;
  functional_location_id: string | null;
  schedule_code: string;
  schedule_name: string;
  target_type: string;
  target_id: string;
  schedule_status: string;
};

const BASE_QUERY = `
  SELECT
    gt.id AS task_id,
    gt.client_id AS client_id,
    gt.building_id AS building_id,
    gt.occurrence_at AS occurrence_at,
    gt.status AS status,
    gt.started_at AS started_at,
    gt.completed_at AS completed_at,
    gt.completed_by_user_id AS completed_by_user_id,
    gt.completion_notes AS completion_notes,
    gt.created_at AS created_at,
    gt.updated_at AS updated_at,
    csb.id AS schedule_binding_id,
    csb.schedule_definition_id AS schedule_definition_id,
    ca.id AS cleaning_area_id,
    ca.code AS cleaning_area_code,
    ca.name AS cleaning_area_name,
    ca.cleaning_area_type AS cleaning_area_type,
    ca.status AS cleaning_area_status,
    ca.floor_id AS floor_id,
    ca.area_id AS area_id,
    ca.room_id AS room_id,
    ca.space_id AS space_id,
    ca.functional_location_id AS functional_location_id,
    sd.code AS schedule_code,
    sd.name AS schedule_name,
    sd.target_type AS target_type,
    sd.target_id AS target_id,
    sd.status AS schedule_status
  FROM generated_tasks gt
  JOIN cleaning_schedule_bindings csb
    ON csb.schedule_definition_id = gt.schedule_definition_id
   AND csb.status = 'ACTIVE'
  JOIN cleaning_areas ca
    ON ca.id = csb.cleaning_area_id
   AND ca.status = 'ACTIVE'
  JOIN schedule_definitions sd
    ON sd.id = gt.schedule_definition_id
`;

/**
 * CR-BE-RN13-CLEANING-FIELD-01 PART 00 — deterministic task → Cleaning Area
 * resolution.
 *
 * `BASE_QUERY` joins `generated_tasks → cleaning_schedule_bindings →
 * cleaning_areas`, so its row count equals the number of ACTIVE cleaning
 * schedule bindings on the task's schedule definition. Migration 0352 caps
 * that at one, which makes this a genuine single-row lookup.
 *
 * Previously this returned `rows[0]`, silently picking an arbitrary Cleaning
 * Area whenever a schedule was ACTIVE against several areas. Under the new
 * invariant more than one row means corrupted data, so it fails explicitly
 * instead of guessing. This is the single chokepoint every Housekeeping
 * consumer (evidence, findings, complaints, quality audits, supervisor
 * inspections, cleaning assignments) resolves a daily cleaning through.
 */
export async function findById(id: string): Promise<DailyCleaningRow | null> {
  const result = await getPool().query<DailyCleaningRow>(
    `${BASE_QUERY} WHERE gt.id = $1`,
    [id],
  );

  if (result.rows.length > 1) {
    throw dailyCleaningAreaAmbiguousError(id);
  }

  return result.rows[0] ?? null;
}

export async function listByBuilding(
  buildingId: string,
  filter: DailyCleaningFilter = {},
  dateWindow?: { start: Date; end: Date },
): Promise<DailyCleaningRow[]> {
  const conditions = ['gt.building_id = $1'];
  const values: unknown[] = [buildingId];

  if (dateWindow) {
    values.push(dateWindow.start);
    conditions.push(`gt.occurrence_at >= $${values.length}`);
    values.push(dateWindow.end);
    conditions.push(`gt.occurrence_at < $${values.length}`);
  }

  if (filter.cleaningAreaId) {
    values.push(filter.cleaningAreaId);
    conditions.push(`ca.id = $${values.length}`);
  }

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`gt.status = $${values.length}`);
  }

  const result = await getPool().query<DailyCleaningRow>(
    `${BASE_QUERY}
     WHERE ${conditions.join(' AND ')}
     ORDER BY gt.occurrence_at ASC, ca.code ASC`,
    values,
  );
  return result.rows;
}

export async function listByArea(
  cleaningAreaId: string,
  filter: DailyCleaningFilter = {},
  dateWindow?: { start: Date; end: Date },
): Promise<DailyCleaningRow[]> {
  const conditions = ['ca.id = $1'];
  const values: unknown[] = [cleaningAreaId];

  if (dateWindow) {
    values.push(dateWindow.start);
    conditions.push(`gt.occurrence_at >= $${values.length}`);
    values.push(dateWindow.end);
    conditions.push(`gt.occurrence_at < $${values.length}`);
  }

  if (filter.status) {
    values.push(filter.status);
    conditions.push(`gt.status = $${values.length}`);
  }

  const result = await getPool().query<DailyCleaningRow>(
    `${BASE_QUERY}
     WHERE ${conditions.join(' AND ')}
     ORDER BY gt.occurrence_at ASC`,
    values,
  );
  return result.rows;
}

export const dailyCleaningRepository = {
  findById,
  listByArea,
  listByBuilding,
};

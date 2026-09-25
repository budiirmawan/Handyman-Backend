import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CleaningScheduleBindingFilter,
  CleaningScheduleBindingRecord,
  CleaningScheduleBindingStatus,
  UpdateCleaningScheduleBindingInput,
} from './cleaning-schedule-binding.types';

type CleaningScheduleBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  cleaning_area_id: string;
  schedule_definition_id: string;
  description: string | null;
  status: CleaningScheduleBindingStatus;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

export type ScheduleDefinitionRow = {
  id: string;
  client_id: string;
  building_id: string | null;
  code: string;
  name: string;
  target_type: string;
  target_id: string;
  start_at: Date;
  end_at: Date | null;
  timezone: string;
  status: string;
  created_at: Date;
  updated_at: Date;
};

export type ScheduleRecurrenceRow = {
  id: string;
  schedule_definition_id: string;
  frequency: string;
  interval: number;
  days_of_week: number[] | null;
  day_of_month: number | null;
  start_date: string | Date;
  end_date: string | Date | null;
  status: string;
  created_at: Date;
  updated_at: Date;
};

export type CleaningAreaRow = {
  id: string;
  client_id: string;
  building_id: string;
  code: string;
  name: string;
  cleaning_area_type: string;
  status: string;
};

function mapRow(row: CleaningScheduleBindingRow): CleaningScheduleBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    cleaningAreaId: row.cleaning_area_id,
    scheduleDefinitionId: row.schedule_definition_id,
    description: row.description,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: {
    clientId: string;
    buildingId: string;
    cleaningAreaId: string;
    scheduleDefinitionId: string;
    description: string | null;
    status: CleaningScheduleBindingStatus;
    createdByUserId: string;
  },
): Promise<CleaningScheduleBindingRecord> {
  const result = await getPool().query<CleaningScheduleBindingRow>(
    `INSERT INTO cleaning_schedule_bindings
       (id, client_id, building_id, cleaning_area_id, schedule_definition_id,
        description, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, client_id, building_id, cleaning_area_id,
               schedule_definition_id, description, status,
               created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.cleaningAreaId,
      input.scheduleDefinitionId,
      input.description ?? null,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<CleaningScheduleBindingRecord | null> {
  const result = await getPool().query<CleaningScheduleBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            schedule_definition_id, description, status,
            created_by_user_id, created_at, updated_at
     FROM cleaning_schedule_bindings
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findActiveByAreaAndSchedule(
  cleaningAreaId: string,
  scheduleDefinitionId: string,
): Promise<CleaningScheduleBindingRecord | null> {
  const result = await getPool().query<CleaningScheduleBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            schedule_definition_id, description, status,
            created_by_user_id, created_at, updated_at
     FROM cleaning_schedule_bindings
     WHERE cleaning_area_id = $1 AND schedule_definition_id = $2
       AND status = 'ACTIVE'`,
    [cleaningAreaId, scheduleDefinitionId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * CR-BE-RN13-CLEANING-FIELD-01 PART 00 — the ACTIVE binding holding a schedule
 * definition, regardless of which Cleaning Area holds it.
 *
 * Backs the one-ACTIVE-binding-per-schedule invariant: at most one row can
 * exist under `cleaning_schedule_bindings_schedule_active_unique`
 * (migration 0352), so this is a genuine single-row lookup.
 */
export async function findActiveBySchedule(
  scheduleDefinitionId: string,
): Promise<CleaningScheduleBindingRecord | null> {
  const result = await getPool().query<CleaningScheduleBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            schedule_definition_id, description, status,
            created_by_user_id, created_at, updated_at
     FROM cleaning_schedule_bindings
     WHERE schedule_definition_id = $1
       AND status = 'ACTIVE'`,
    [scheduleDefinitionId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByAreaId(
  cleaningAreaId: string,
  filter: CleaningScheduleBindingFilter = {},
): Promise<CleaningScheduleBindingRecord[]> {
  const conditions = ['cleaning_area_id = $1'];
  const values: unknown[] = [cleaningAreaId];

  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<CleaningScheduleBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            schedule_definition_id, description, status,
            created_by_user_id, created_at, updated_at
     FROM cleaning_schedule_bindings
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingId(
  buildingId: string,
  filter: CleaningScheduleBindingFilter = {},
): Promise<CleaningScheduleBindingRecord[]> {
  const conditions = ['building_id = $1'];
  const values: unknown[] = [buildingId];

  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  if (filter.cleaningAreaId !== undefined) {
    values.push(filter.cleaningAreaId);
    conditions.push(`cleaning_area_id = $${values.length}`);
  }

  if (filter.scheduleDefinitionId !== undefined) {
    values.push(filter.scheduleDefinitionId);
    conditions.push(`schedule_definition_id = $${values.length}`);
  }

  const result = await getPool().query<CleaningScheduleBindingRow>(
    `SELECT id, client_id, building_id, cleaning_area_id,
            schedule_definition_id, description, status,
            created_by_user_id, created_at, updated_at
     FROM cleaning_schedule_bindings
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdateCleaningScheduleBindingInput,
): Promise<CleaningScheduleBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }

  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  const result = await getPool().query<CleaningScheduleBindingRow>(
    `UPDATE cleaning_schedule_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, cleaning_area_id,
               schedule_definition_id, description, status,
               created_by_user_id, created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findSchedule(
  id: string,
): Promise<ScheduleDefinitionRow | null> {
  const result = await getPool().query<ScheduleDefinitionRow>(
    `SELECT id, client_id, building_id, code, name, target_type,
            target_id, start_at, end_at, timezone, status,
            created_at, updated_at
     FROM schedule_definitions
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findScheduleRecurrence(
  scheduleDefinitionId: string,
): Promise<ScheduleRecurrenceRow | null> {
  const result = await getPool().query<ScheduleRecurrenceRow>(
    `SELECT id, schedule_definition_id, frequency, interval,
            days_of_week, day_of_month, start_date, end_date,
            status, created_at, updated_at
     FROM schedule_recurrence
     WHERE schedule_definition_id = $1`,
    [scheduleDefinitionId],
  );
  return result.rows[0] ?? null;
}

export async function findCleaningArea(
  id: string,
): Promise<CleaningAreaRow | null> {
  const result = await getPool().query<CleaningAreaRow>(
    `SELECT id, client_id, building_id, code, name, cleaning_area_type, status
     FROM cleaning_areas
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function insertSchedule(input: {
  clientId: string;
  buildingId: string;
  code: string;
  name: string;
  targetType: string;
  targetId: string;
  startAt: string;
  endAt?: string | null;
  timezone: string;
}): Promise<ScheduleDefinitionRow> {
  const result = await getPool().query<ScheduleDefinitionRow>(
    `INSERT INTO schedule_definitions
       (id, client_id, building_id, code, name, target_type, target_id,
        start_at, end_at, timezone, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE')
     RETURNING id, client_id, building_id, code, name, target_type,
               target_id, start_at, end_at, timezone, status,
               created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.code,
      input.name,
      input.targetType,
      input.targetId,
      input.startAt,
      input.endAt ?? null,
      input.timezone,
    ],
  );
  return result.rows[0];
}

export const cleaningScheduleBindingRepository = {
  create,
  findActiveByAreaAndSchedule,
  findActiveBySchedule,
  findCleaningArea,
  findById,
  findSchedule,
  findScheduleRecurrence,
  insertSchedule,
  listByAreaId,
  listByBuildingId,
  update,
};

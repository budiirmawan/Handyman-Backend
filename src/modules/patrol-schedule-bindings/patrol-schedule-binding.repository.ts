import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { PatrolRouteRow } from '../patrol-routes';
import type {
  CreatePatrolScheduleBindingInput,
  PatrolScheduleBindingFilter,
  PatrolScheduleBindingRecord,
  PatrolScheduleBindingStatus,
  UpdatePatrolScheduleBindingInput,
} from './patrol-schedule-binding.types';

type PatrolScheduleBindingRow = {
  id: string;
  client_id: string;
  building_id: string;
  patrol_route_id: string;
  schedule_definition_id: string;
  start_security_post_id: string | null;
  description: string | null;
  status: PatrolScheduleBindingStatus;
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

function mapRow(
  row: PatrolScheduleBindingRow,
): PatrolScheduleBindingRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    patrolRouteId: row.patrol_route_id,
    scheduleDefinitionId: row.schedule_definition_id,
    startSecurityPostId: row.start_security_post_id,
    description: row.description,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function create(
  input: Omit<CreatePatrolScheduleBindingInput, 'createdByUserId'> & {
    clientId: string;
    buildingId: string;
    scheduleDefinitionId: string;
    createdByUserId: string;
  },
): Promise<PatrolScheduleBindingRecord> {
  const result = await getPool().query<PatrolScheduleBindingRow>(
    `INSERT INTO patrol_schedule_bindings
       (id, client_id, building_id, patrol_route_id, schedule_definition_id,
        start_security_post_id, description, status, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, building_id, patrol_route_id,
               schedule_definition_id, start_security_post_id, description,
               status, created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.patrolRouteId,
      input.scheduleDefinitionId,
      input.startSecurityPostId ?? null,
      input.description ?? null,
      input.status,
      input.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(
  id: string,
): Promise<PatrolScheduleBindingRecord | null> {
  const result = await getPool().query<PatrolScheduleBindingRow>(
    `SELECT id, client_id, building_id, patrol_route_id,
            schedule_definition_id, start_security_post_id, description,
            status, created_by_user_id, created_at, updated_at
     FROM patrol_schedule_bindings
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * CR-BE-RN16-PATROL-FIELD-01 PART 00 — the ACTIVE binding of a schedule
 * definition, whatever Patrol Route it points at.
 *
 * This is the cardinality authority for patrol scheduling: migration 0354
 * makes `patrol_schedule_bindings` unique on `(schedule_definition_id) WHERE
 * status = 'ACTIVE'`, so this lookup returns at most one row. It is the
 * schedule-side counterpart of `findActiveByRouteAndSchedule` below and is
 * what the create/reactivate guard uses, because the defect it closes is a
 * SECOND ACTIVE binding arriving through a DIFFERENT patrol route — a
 * route-scoped check cannot see that row.
 */
export async function findActiveByScheduleDefinitionId(
  scheduleDefinitionId: string,
): Promise<PatrolScheduleBindingRecord | null> {
  const result = await getPool().query<PatrolScheduleBindingRow>(
    `SELECT id, client_id, building_id, patrol_route_id,
            schedule_definition_id, start_security_post_id, description,
            status, created_by_user_id, created_at, updated_at
     FROM patrol_schedule_bindings
     WHERE schedule_definition_id = $1
       AND status = 'ACTIVE'`,
    [scheduleDefinitionId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/**
 * The ACTIVE binding of one (Patrol Route, schedule definition) PAIR.
 *
 * Still a valid reverse lookup and still used for the pair-scoped read
 * surface, but it is deliberately NOT the write guard any more (PART 00):
 * being pair-scoped, it cannot detect a second ACTIVE binding that arrives
 * through another route, so `findActiveByScheduleDefinitionId` above is the
 * authority that decides whether a schedule may acquire an ACTIVE binding.
 */
export async function findActiveByRouteAndSchedule(
  patrolRouteId: string,
  scheduleDefinitionId: string,
): Promise<PatrolScheduleBindingRecord | null> {
  const result = await getPool().query<PatrolScheduleBindingRow>(
    `SELECT id, client_id, building_id, patrol_route_id,
            schedule_definition_id, start_security_post_id, description,
            status, created_by_user_id, created_at, updated_at
     FROM patrol_schedule_bindings
     WHERE patrol_route_id = $1 AND schedule_definition_id = $2
       AND status = 'ACTIVE'`,
    [patrolRouteId, scheduleDefinitionId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function listByRouteId(
  patrolRouteId: string,
  filter: PatrolScheduleBindingFilter = {},
): Promise<PatrolScheduleBindingRecord[]> {
  const conditions = ['patrol_route_id = $1'];
  const values: unknown[] = [patrolRouteId];

  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  const result = await getPool().query<PatrolScheduleBindingRow>(
    `SELECT id, client_id, building_id, patrol_route_id,
            schedule_definition_id, start_security_post_id, description,
            status, created_by_user_id, created_at, updated_at
     FROM patrol_schedule_bindings
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function listByBuildingId(
  buildingId: string,
  filter: PatrolScheduleBindingFilter = {},
): Promise<PatrolScheduleBindingRecord[]> {
  const conditions = ['building_id = $1'];
  const values: unknown[] = [buildingId];

  if (filter.status !== undefined) {
    values.push(filter.status);
    conditions.push(`status = $${values.length}`);
  }

  if (filter.patrolRouteId !== undefined) {
    values.push(filter.patrolRouteId);
    conditions.push(`patrol_route_id = $${values.length}`);
  }

  if (filter.scheduleDefinitionId !== undefined) {
    values.push(filter.scheduleDefinitionId);
    conditions.push(`schedule_definition_id = $${values.length}`);
  }

  const result = await getPool().query<PatrolScheduleBindingRow>(
    `SELECT id, client_id, building_id, patrol_route_id,
            schedule_definition_id, start_security_post_id, description,
            status, created_by_user_id, created_at, updated_at
     FROM patrol_schedule_bindings
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    values,
  );
  return result.rows.map(mapRow);
}

export async function update(
  id: string,
  input: UpdatePatrolScheduleBindingInput,
): Promise<PatrolScheduleBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.startSecurityPostId !== undefined) {
    values.push(input.startSecurityPostId);
    sets.push(`start_security_post_id = $${values.length}`);
  }

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
  const result = await getPool().query<PatrolScheduleBindingRow>(
    `UPDATE patrol_schedule_bindings
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${values.length}
     RETURNING id, client_id, building_id, patrol_route_id,
               schedule_definition_id, start_security_post_id, description,
               status, created_by_user_id, created_at, updated_at`,
    values,
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export async function findPatrolRoute(
  id: string,
): Promise<PatrolRouteRow | null> {
  const result = await getPool().query<PatrolRouteRow>(
    `SELECT id, client_id, building_id, start_security_post_id, code, name,
            description, status
     FROM patrol_routes
     WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function countActivePatrolRoutePoints(
  patrolRouteId: string,
): Promise<number> {
  const result = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM patrol_route_points
     WHERE patrol_route_id = $1 AND status = 'ACTIVE'`,
    [patrolRouteId],
  );
  return result.rows[0]?.n ?? 0;
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

export const patrolScheduleBindingRepository = {
  countActivePatrolRoutePoints,
  create,
  findActiveByRouteAndSchedule,
  findActiveByScheduleDefinitionId,
  findById,
  findPatrolRoute,
  findSchedule,
  findScheduleRecurrence,
  insertSchedule,
  listByBuildingId,
  listByRouteId,
  update,
};

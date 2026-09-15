import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import {
  patrolRouteNotFoundError,
  patrolRouteRepository,
} from '../patrol-routes';
import { securityPostRepository } from '../security-posts';
import {
  patrolRouteBindingBuildingMismatchError,
  patrolRouteHasNoPointsError,
  patrolScheduleBindingAlreadyExistsError,
  patrolScheduleBindingNotFoundError,
  patrolScheduleBuildingMismatchError,
  patrolScheduleClientMismatchError,
  patrolScheduleInactiveError,
  patrolScheduleNotFoundError,
  patrolScheduleTargetMismatchError,
} from './patrol-schedule-binding.errors';
import { patrolScheduleBindingRepository } from './patrol-schedule-binding.repository';
import type {
  CreatePatrolScheduleBindingInput,
  PatrolScheduleBindingFilter,
  PatrolScheduleBindingRecord,
  PublicPatrolScheduleBinding,
  UpdatePatrolScheduleBindingInput,
} from './patrol-schedule-binding.types';

const SCHEDULE_TARGET_TABLES: Record<string, string> = {
  FORM_TEMPLATE: 'form_templates',
  FORM_VERSION: 'form_template_versions',
  CHECKLIST_TEMPLATE: 'checklist_templates',
};

/**
 * Resolves a BE-07 schedule `target` (e.g. CHECKLIST_TEMPLATE) and asserts
 * it exists, is ACTIVE, and belongs to the same Client. The schedule
 * definition — not the target — owns the Building context, so the
 * target is only checked for client + status.
 */
async function resolveScheduleTarget(
  targetType: string,
  targetId: string,
  clientId: string,
): Promise<{ id: string; client_id: string; status: string } | null> {
  const table = SCHEDULE_TARGET_TABLES[targetType];
  if (!table) {
    return null;
  }

  const result = await getPool().query<{
    id: string;
    client_id: string;
    status: string;
  }>(
    `SELECT id, client_id, status FROM ${table} WHERE id = $1`,
    [targetId],
  );

  const row = result.rows[0];
  if (!row || row.client_id !== clientId) {
    return null;
  }
  return row;
}

/* ------------------------------------------------------------------ */
/*  Public binding context resolution                                 */
/* ------------------------------------------------------------------ */

export async function resolveBindingContext(
  record: PatrolScheduleBindingRecord,
): Promise<PublicPatrolScheduleBinding> {
  const route = await patrolScheduleBindingRepository.findPatrolRoute(
    record.patrolRouteId,
  );
  const schedule = await patrolScheduleBindingRepository.findSchedule(
    record.scheduleDefinitionId,
  );
  const recurrence = schedule
    ? await patrolScheduleBindingRepository.findScheduleRecurrence(schedule.id)
    : null;

  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    patrolRouteId: record.patrolRouteId,
    scheduleDefinitionId: record.scheduleDefinitionId,
    startSecurityPostId: record.startSecurityPostId,
    description: record.description,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(route
      ? {
          patrolRoute: {
            id: route.id,
            code: route.code,
            name: route.name,
            status: route.status,
          },
        }
      : {}),
    ...(schedule
      ? {
          schedule: {
            id: schedule.id,
            code: schedule.code,
            name: schedule.name,
            targetType: schedule.target_type,
            targetId: schedule.target_id,
            startAt:
              schedule.start_at instanceof Date
                ? schedule.start_at.toISOString()
                : String(schedule.start_at),
            endAt: schedule.end_at
              ? schedule.end_at instanceof Date
                ? schedule.end_at.toISOString()
                : String(schedule.end_at)
              : null,
            timezone: schedule.timezone,
            status: schedule.status,
            recurrence: recurrence
              ? {
                  id: recurrence.id,
                  frequency: recurrence.frequency,
                  interval: recurrence.interval,
                  daysOfWeek: recurrence.days_of_week,
                  dayOfMonth: recurrence.day_of_month,
                  startDate:
                    recurrence.start_date instanceof Date
                      ? recurrence.start_date.toISOString().slice(0, 10)
                      : String(recurrence.start_date),
                  endDate: recurrence.end_date
                    ? recurrence.end_date instanceof Date
                      ? recurrence.end_date.toISOString().slice(0, 10)
                      : String(recurrence.end_date)
                    : null,
                  status: recurrence.status,
                }
              : null,
          },
        }
      : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Create                                                             */
/* ------------------------------------------------------------------ */

export async function createPatrolScheduleBinding(
  input: CreatePatrolScheduleBindingInput,
): Promise<PublicPatrolScheduleBinding> {
  const route = await patrolScheduleBindingRepository.findPatrolRoute(
    input.patrolRouteId,
  );
  if (!route) {
    throw patrolRouteNotFoundError();
  }
  if (route.status !== 'ACTIVE') {
    throw patrolRouteNotFoundError();
  }

  const pointCount =
    await patrolScheduleBindingRepository.countActivePatrolRoutePoints(
      input.patrolRouteId,
    );
  if (pointCount === 0) {
    throw patrolRouteHasNoPointsError();
  }

  let scheduleId = input.scheduleDefinitionId;

  if (scheduleId) {
    const existingSchedule =
      await patrolScheduleBindingRepository.findSchedule(scheduleId);
    if (!existingSchedule) {
      throw patrolScheduleNotFoundError();
    }
    if (existingSchedule.status === 'INACTIVE') {
      throw patrolScheduleInactiveError();
    }
    if (existingSchedule.client_id !== route.client_id) {
      throw patrolScheduleClientMismatchError();
    }
    if (
      existingSchedule.building_id &&
      existingSchedule.building_id !== route.building_id
    ) {
      throw patrolScheduleBuildingMismatchError();
    }
  } else {
    if (
      !input.targetType ||
      !input.targetId ||
      !input.name ||
      !input.startAt ||
      !input.timezone
    ) {
      throw AppError.validation('Schedule creation details incomplete.');
    }

    const target = await resolveScheduleTarget(
      input.targetType,
      input.targetId,
      route.client_id,
    );
    if (!target) {
      throw patrolScheduleTargetMismatchError();
    }
    if (target.status !== 'ACTIVE') {
      throw AppError.badRequest(
        'Inactive target cannot receive an active schedule.',
      );
    }

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
    } catch {
      throw AppError.badRequest('Invalid timezone.');
    }

    if (
      input.endAt &&
      new Date(input.startAt) > new Date(input.endAt)
    ) {
      throw AppError.badRequest('startAt must not exceed endAt.');
    }

    const createdSchedule =
      await patrolScheduleBindingRepository.insertSchedule({
        clientId: route.client_id,
        buildingId: route.building_id,
        code: (
          input.code ?? `PB_${randomUUID().slice(0, 8).toUpperCase()}`
        ).toUpperCase(),
        name: input.name,
        targetType: input.targetType,
        targetId: input.targetId,
        startAt: input.startAt,
        endAt: input.endAt,
        timezone: input.timezone,
      });
    scheduleId = createdSchedule.id;
  }

  if (input.startSecurityPostId) {
    const post = await securityPostRepository.findById(
      input.startSecurityPostId,
    );
    if (!post) {
      throw patrolRouteNotFoundError();
    }
    if (post.buildingId !== route.building_id) {
      throw patrolRouteBindingBuildingMismatchError();
    }
  }

  const activeExisting =
    await patrolScheduleBindingRepository.findActiveByRouteAndSchedule(
      input.patrolRouteId,
      scheduleId,
    );
  if (activeExisting) {
    throw patrolScheduleBindingAlreadyExistsError();
  }

  try {
    const record = await patrolScheduleBindingRepository.create({
      clientId: route.client_id,
      buildingId: route.building_id,
      patrolRouteId: input.patrolRouteId,
      scheduleDefinitionId: scheduleId,
      startSecurityPostId: input.startSecurityPostId ?? null,
      description: input.description ?? null,
      status: input.status ?? 'ACTIVE',
      createdByUserId: input.createdByUserId,
    });
    return resolveBindingContext(record);
  } catch (error) {
    if (isPatrolScheduleBindingUniqueViolation(error)) {
      throw patrolScheduleBindingAlreadyExistsError();
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/*  Read                                                               */
/* ------------------------------------------------------------------ */

export async function getPatrolScheduleBindingById(
  id: string,
): Promise<PublicPatrolScheduleBinding> {
  const record = await patrolScheduleBindingRepository.findById(id);
  if (!record) {
    throw patrolScheduleBindingNotFoundError();
  }
  return resolveBindingContext(record);
}

export async function listPatrolScheduleBindingsByRoute(
  patrolRouteId: string,
  filter: PatrolScheduleBindingFilter = {},
): Promise<PublicPatrolScheduleBinding[]> {
  const route = await patrolRouteRepository.findById(patrolRouteId);
  if (!route) {
    throw patrolRouteNotFoundError();
  }

  const records = await patrolScheduleBindingRepository.listByRouteId(
    patrolRouteId,
    filter,
  );
  return Promise.all(records.map(resolveBindingContext));
}

export async function listPatrolScheduleBindingsByBuilding(
  buildingId: string,
  filter: PatrolScheduleBindingFilter = {},
): Promise<PublicPatrolScheduleBinding[]> {
  const records = await patrolScheduleBindingRepository.listByBuildingId(
    buildingId,
    filter,
  );
  return Promise.all(records.map(resolveBindingContext));
}

/* ------------------------------------------------------------------ */
/*  Update                                                             */
/* ------------------------------------------------------------------ */

export async function updatePatrolScheduleBinding(
  id: string,
  input: UpdatePatrolScheduleBindingInput,
): Promise<PublicPatrolScheduleBinding> {
  const existing = await patrolScheduleBindingRepository.findById(id);
  if (!existing) {
    throw patrolScheduleBindingNotFoundError();
  }

  if (input.startSecurityPostId !== undefined && input.startSecurityPostId) {
    const post = await securityPostRepository.findById(
      input.startSecurityPostId,
    );
    if (!post) {
      throw patrolRouteNotFoundError();
    }
    if (post.buildingId !== existing.buildingId) {
      throw patrolRouteBindingBuildingMismatchError();
    }
  }

  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    const route = await patrolScheduleBindingRepository.findPatrolRoute(
      existing.patrolRouteId,
    );
    if (!route || route.status !== 'ACTIVE') {
      throw patrolRouteNotFoundError();
    }

    const pointCount =
      await patrolScheduleBindingRepository.countActivePatrolRoutePoints(
        existing.patrolRouteId,
      );
    if (pointCount === 0) {
      throw patrolRouteHasNoPointsError();
    }

    const activeExisting =
      await patrolScheduleBindingRepository.findActiveByRouteAndSchedule(
        existing.patrolRouteId,
        existing.scheduleDefinitionId,
      );
    if (activeExisting && activeExisting.id !== id) {
      throw patrolScheduleBindingAlreadyExistsError();
    }
  }

  const record = await patrolScheduleBindingRepository.update(id, input);
  return resolveBindingContext(record as PatrolScheduleBindingRecord);
}

function isPatrolScheduleBindingUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'patrol_schedule_bindings_active_unique'
  );
}

export const patrolScheduleBindingService = {
  createPatrolScheduleBinding,
  getPatrolScheduleBindingById,
  listPatrolScheduleBindingsByBuilding,
  listPatrolScheduleBindingsByRoute,
  resolveBindingContext,
  updatePatrolScheduleBinding,
};

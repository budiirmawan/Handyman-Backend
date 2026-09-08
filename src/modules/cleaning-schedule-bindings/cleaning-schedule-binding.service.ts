import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import { AppError } from '../../shared/errors';
import {
  cleaningAreaInactiveError,
  cleaningAreaNotFoundError,
} from '../cleaning-areas';
import {
  cleaningScheduleBindingAlreadyExistsError,
  cleaningScheduleBindingNotFoundError,
  cleaningScheduleBuildingMismatchError,
  cleaningScheduleClientMismatchError,
  cleaningScheduleInactiveError,
  cleaningScheduleNotFoundError,
} from './cleaning-schedule-binding.errors';
import {
  cleaningScheduleBindingRepository,
  type CleaningAreaRow,
  type ScheduleDefinitionRow,
  type ScheduleRecurrenceRow,
} from './cleaning-schedule-binding.repository';
import type {
  CleaningScheduleBindingFilter,
  CleaningScheduleBindingRecord,
  CreateCleaningScheduleBindingInput,
  PublicCleaningScheduleBinding,
  UpdateCleaningScheduleBindingInput,
} from './cleaning-schedule-binding.types';

const SCHEDULE_TARGET_TABLES: Record<string, string> = {
  FORM_TEMPLATE: 'form_templates',
  FORM_VERSION: 'form_template_versions',
  CHECKLIST_TEMPLATE: 'checklist_templates',
};

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
  }>(`SELECT id, client_id, status FROM ${table} WHERE id = $1`, [targetId]);

  const row = result.rows[0];
  if (!row || row.client_id !== clientId) {
    return null;
  }
  return row;
}

export async function resolveBindingContext(
  record: CleaningScheduleBindingRecord,
): Promise<PublicCleaningScheduleBinding> {
  const area = await cleaningScheduleBindingRepository.findCleaningArea(
    record.cleaningAreaId,
  );
  const schedule = await cleaningScheduleBindingRepository.findSchedule(
    record.scheduleDefinitionId,
  );
  const recurrence = schedule
    ? await cleaningScheduleBindingRepository.findScheduleRecurrence(schedule.id)
    : null;

  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    cleaningAreaId: record.cleaningAreaId,
    scheduleDefinitionId: record.scheduleDefinitionId,
    description: record.description,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(area
      ? {
          cleaningArea: {
            id: area.id,
            code: area.code,
            name: area.name,
            cleaningAreaType: area.cleaning_area_type,
            status: area.status,
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

export async function createCleaningScheduleBinding(
  input: CreateCleaningScheduleBindingInput,
): Promise<PublicCleaningScheduleBinding> {
  const area = await cleaningScheduleBindingRepository.findCleaningArea(
    input.cleaningAreaId,
  );
  if (!area) {
    throw cleaningAreaNotFoundError();
  }
  if (area.status !== 'ACTIVE') {
    throw cleaningAreaInactiveError();
  }

  let scheduleId = input.scheduleDefinitionId;

  if (scheduleId) {
    const existingSchedule =
      await cleaningScheduleBindingRepository.findSchedule(scheduleId);
    if (!existingSchedule) {
      throw cleaningScheduleNotFoundError();
    }
    if (existingSchedule.status === 'INACTIVE') {
      throw cleaningScheduleInactiveError();
    }
    if (existingSchedule.client_id !== area.client_id) {
      throw cleaningScheduleClientMismatchError();
    }
    if (
      existingSchedule.building_id &&
      existingSchedule.building_id !== area.building_id
    ) {
      throw cleaningScheduleBuildingMismatchError();
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
      area.client_id,
    );
    if (!target) {
      throw AppError.badRequest('Schedule target does not exist.');
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
      await cleaningScheduleBindingRepository.insertSchedule({
        clientId: area.client_id,
        buildingId: area.building_id,
        code: (
          input.code ?? `CS_${randomUUID().slice(0, 8).toUpperCase()}`
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

  const activeExisting =
    await cleaningScheduleBindingRepository.findActiveByAreaAndSchedule(
      input.cleaningAreaId,
      scheduleId,
    );
  if (activeExisting) {
    throw cleaningScheduleBindingAlreadyExistsError();
  }

  try {
    const record = await cleaningScheduleBindingRepository.create({
      clientId: area.client_id,
      buildingId: area.building_id,
      cleaningAreaId: input.cleaningAreaId,
      scheduleDefinitionId: scheduleId,
      description: input.description ?? null,
      status: input.status ?? 'ACTIVE',
      createdByUserId: input.createdByUserId,
    });
    return resolveBindingContext(record);
  } catch (error) {
    if (isCleaningScheduleBindingUniqueViolation(error)) {
      throw cleaningScheduleBindingAlreadyExistsError();
    }
    throw error;
  }
}

export async function getCleaningScheduleBindingById(
  id: string,
): Promise<PublicCleaningScheduleBinding> {
  const record = await cleaningScheduleBindingRepository.findById(id);
  if (!record) {
    throw cleaningScheduleBindingNotFoundError();
  }
  return resolveBindingContext(record);
}

export async function listCleaningScheduleBindingsByArea(
  cleaningAreaId: string,
  filter: CleaningScheduleBindingFilter = {},
): Promise<PublicCleaningScheduleBinding[]> {
  const area = await cleaningScheduleBindingRepository.findCleaningArea(
    cleaningAreaId,
  );
  if (!area) {
    throw cleaningAreaNotFoundError();
  }

  const records = await cleaningScheduleBindingRepository.listByAreaId(
    cleaningAreaId,
    filter,
  );
  return Promise.all(records.map(resolveBindingContext));
}

export async function listCleaningScheduleBindingsByBuilding(
  buildingId: string,
  filter: CleaningScheduleBindingFilter = {},
): Promise<PublicCleaningScheduleBinding[]> {
  const records = await cleaningScheduleBindingRepository.listByBuildingId(
    buildingId,
    filter,
  );
  return Promise.all(records.map(resolveBindingContext));
}

export async function updateCleaningScheduleBinding(
  id: string,
  input: UpdateCleaningScheduleBindingInput,
): Promise<PublicCleaningScheduleBinding> {
  const existing = await cleaningScheduleBindingRepository.findById(id);
  if (!existing) {
    throw cleaningScheduleBindingNotFoundError();
  }

  if (input.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
    const area = await cleaningScheduleBindingRepository.findCleaningArea(
      existing.cleaningAreaId,
    );
    if (!area || area.status !== 'ACTIVE') {
      throw cleaningAreaInactiveError();
    }

    const activeExisting =
      await cleaningScheduleBindingRepository.findActiveByAreaAndSchedule(
        existing.cleaningAreaId,
        existing.scheduleDefinitionId,
      );
    if (activeExisting && activeExisting.id !== id) {
      throw cleaningScheduleBindingAlreadyExistsError();
    }
  }

  const record = await cleaningScheduleBindingRepository.update(id, input);
  return resolveBindingContext(record as CleaningScheduleBindingRecord);
}

function isCleaningScheduleBindingUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: string; constraint?: string };
  return (
    candidate.code === '23505' &&
    candidate.constraint === 'cleaning_schedule_bindings_active_unique'
  );
}

export const cleaningScheduleBindingService = {
  createCleaningScheduleBinding,
  getCleaningScheduleBindingById,
  listCleaningScheduleBindingsByArea,
  listCleaningScheduleBindingsByBuilding,
  resolveBindingContext,
  updateCleaningScheduleBinding,
};

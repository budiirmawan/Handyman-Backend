import { buildingNotFoundError, buildingRepository } from '../buildings';
import {
  cleaningAreaBuildingMismatchError,
  cleaningAreaInactiveError,
  cleaningAreaNotFoundError,
  cleaningAreaRepository,
} from '../cleaning-areas';
import { dailyCleaningNotFoundError } from './daily-cleaning.errors';
import {
  dailyCleaningRepository,
  type DailyCleaningRow,
} from './daily-cleaning.repository';
import type {
  DailyCleaningFilter,
  PublicDailyCleaning,
} from './daily-cleaning.types';

export function operationalDateWindow(
  dateString: string,
): { start: Date; end: Date } {
  const [year, month, day] = dateString.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, day));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

export function toPublicDailyCleaning(
  row: DailyCleaningRow,
): PublicDailyCleaning {
  const occurrence =
    row.occurrence_at instanceof Date
      ? row.occurrence_at
      : new Date(row.occurrence_at);

  return {
    id: row.task_id,
    taskId: row.task_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    cleaningAreaId: row.cleaning_area_id,
    scheduleBindingId: row.schedule_binding_id,
    scheduleDefinitionId: row.schedule_definition_id,
    operationalDate: occurrence.toISOString().slice(0, 10),
    occurrenceAt: occurrence.toISOString(),
    status: row.status,
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    completedByUserId: row.completed_by_user_id,
    completionNotes: row.completion_notes,
    cleaningArea: {
      id: row.cleaning_area_id,
      code: row.cleaning_area_code,
      name: row.cleaning_area_name,
      cleaningAreaType: row.cleaning_area_type,
      status: row.cleaning_area_status,
      floorId: row.floor_id,
      areaId: row.area_id,
      roomId: row.room_id,
      spaceId: row.space_id,
      functionalLocationId: row.functional_location_id,
    },
    schedule: {
      id: row.schedule_definition_id,
      code: row.schedule_code,
      name: row.schedule_name,
      targetType: row.target_type,
      targetId: row.target_id,
      status: row.schedule_status,
    },
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function getDailyCleaningById(
  id: string,
): Promise<PublicDailyCleaning> {
  const row = await dailyCleaningRepository.findById(id);
  if (!row) {
    throw dailyCleaningNotFoundError();
  }
  return toPublicDailyCleaning(row);
}

export async function listDailyCleaningByBuilding(
  buildingId: string,
  filter: DailyCleaningFilter = {},
): Promise<PublicDailyCleaning[]> {
  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }

  if (filter.cleaningAreaId) {
    const area = await cleaningAreaRepository.findById(filter.cleaningAreaId);
    if (!area) {
      throw cleaningAreaNotFoundError();
    }
    if (area.buildingId !== buildingId) {
      throw cleaningAreaBuildingMismatchError();
    }
    if (area.status !== 'ACTIVE') {
      throw cleaningAreaInactiveError();
    }
  }

  const dateWindow = filter.date
    ? operationalDateWindow(filter.date)
    : undefined;

  const rows = await dailyCleaningRepository.listByBuilding(
    buildingId,
    filter,
    dateWindow,
  );
  return rows.map(toPublicDailyCleaning);
}

export async function listDailyCleaningByArea(
  cleaningAreaId: string,
  filter: DailyCleaningFilter = {},
): Promise<PublicDailyCleaning[]> {
  const area = await cleaningAreaRepository.findById(cleaningAreaId);
  if (!area) {
    throw cleaningAreaNotFoundError();
  }
  if (area.status !== 'ACTIVE') {
    throw cleaningAreaInactiveError();
  }

  const dateWindow = filter.date
    ? operationalDateWindow(filter.date)
    : undefined;

  const rows = await dailyCleaningRepository.listByArea(
    cleaningAreaId,
    filter,
    dateWindow,
  );
  return rows.map(toPublicDailyCleaning);
}

export const dailyCleaningService = {
  getDailyCleaningById,
  listDailyCleaningByArea,
  listDailyCleaningByBuilding,
  toPublicDailyCleaning,
};

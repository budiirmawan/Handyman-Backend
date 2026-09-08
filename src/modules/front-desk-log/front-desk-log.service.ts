import { contextAccessService } from '../context-access';
import {
  frontDeskLogInvalidDateRangeError,
  frontDeskLogNotFoundError,
} from './front-desk-log.errors';
import { frontDeskLogRepository } from './front-desk-log.repository';
import type {
  FrontDeskLogFilters,
  FrontDeskLogIdentity,
  FrontDeskLogRecord,
  PublicFrontDeskLog,
} from './front-desk-log.types';

/**
 * BE-13L — Front Desk Log read service.
 *
 * The repository projects chronological events directly from BE-13
 * authority tables. This service only applies Building scope and filter
 * validation; it never persists or duplicates Visitor/Visit data.
 */
export async function getFrontDeskLog(
  identity: FrontDeskLogIdentity,
  userId: string,
): Promise<PublicFrontDeskLog> {
  const record = await frontDeskLogRepository.findByIdentity(identity);
  if (!record) throw frontDeskLogNotFoundError();
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicFrontDeskLog(record);
}

export async function listFrontDeskLogs(
  filters: FrontDeskLogFilters,
  userId: string,
): Promise<PublicFrontDeskLog[]> {
  if (
    filters.occurredFrom &&
    filters.occurredTo &&
    new Date(filters.occurredFrom).getTime() >
      new Date(filters.occurredTo).getTime()
  ) {
    throw frontDeskLogInvalidDateRangeError();
  }

  let buildingIds: string[];
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await frontDeskLogRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicFrontDeskLog);
}

function toPublicFrontDeskLog(
  record: FrontDeskLogRecord,
): PublicFrontDeskLog {
  return {
    ...record,
    occurredAt: record.occurredAt.toISOString(),
  };
}

export const frontDeskLogService = {
  getFrontDeskLog,
  listFrontDeskLogs,
};

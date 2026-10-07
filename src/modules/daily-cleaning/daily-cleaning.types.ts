/**
 * BE-11C — Daily Cleaning domain types.
 *
 * Daily Cleaning is the Housekeeping operational view of an authoritative
 * BE-07 scheduled task bound to a Cleaning Area (BE-11A/B).
 * No duplicated task or execution engine.
 */

export const DAILY_CLEANING_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

export type DailyCleaningStatus = (typeof DAILY_CLEANING_STATUSES)[number];

export function isDailyCleaningStatus(
  value: unknown,
): value is DailyCleaningStatus {
  return (
    typeof value === 'string' &&
    (DAILY_CLEANING_STATUSES as readonly string[]).includes(value)
  );
}

export type PublicDailyCleaning = {
  id: string;
  taskId: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  scheduleBindingId: string;
  scheduleDefinitionId: string;
  operationalDate: string;
  occurrenceAt: string;
  status: DailyCleaningStatus;
  startedAt: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  cleaningArea: {
    id: string;
    code: string;
    name: string;
    cleaningAreaType: string;
    status: string;
    floorId: string | null;
    areaId: string | null;
    roomId: string | null;
    spaceId: string | null;
    functionalLocationId: string | null;
  };
  schedule: {
    id: string;
    code: string;
    name: string;
    targetType: string;
    targetId: string;
    status: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type DailyCleaningFilter = {
  date?: string;
  cleaningAreaId?: string;
  status?: DailyCleaningStatus;
};

export type DailyCleaningQuery = {
  buildingId: string;
  date?: string;
  cleaningAreaId?: string;
  status?: DailyCleaningStatus;
};

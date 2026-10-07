/**
 * BE-11B — Cleaning Schedule Binding domain types.
 *
 * Links a Housekeeping Cleaning Area (BE-11A) with a BE-07 Schedule Definition
 * under a Building context. Recurrence and task generation are delegated to
 * BE-07.
 */

export const CLEANING_SCHEDULE_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type CleaningScheduleBindingStatus =
  (typeof CLEANING_SCHEDULE_BINDING_STATUSES)[number];

export function isCleaningScheduleBindingStatus(
  value: unknown,
): value is CleaningScheduleBindingStatus {
  return (
    typeof value === 'string' &&
    (CLEANING_SCHEDULE_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type CleaningScheduleBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  scheduleDefinitionId: string;
  description: string | null;
  status: CleaningScheduleBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation with resolved BE-07 schedule & recurrence context. */
export type PublicCleaningScheduleBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  cleaningAreaId: string;
  scheduleDefinitionId: string;
  description: string | null;
  status: CleaningScheduleBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  cleaningArea?: {
    id: string;
    code: string;
    name: string;
    cleaningAreaType: string;
    status: string;
  };
  schedule?: {
    id: string;
    code: string;
    name: string;
    targetType: string;
    targetId: string;
    startAt: string;
    endAt: string | null;
    timezone: string;
    status: string;
    recurrence?: {
      id: string;
      frequency: string;
      interval: number;
      daysOfWeek: number[] | null;
      dayOfMonth: number | null;
      startDate: string;
      endDate: string | null;
      status: string;
    } | null;
  };
};

export type CreateCleaningScheduleBindingInput = {
  cleaningAreaId: string;
  scheduleDefinitionId?: string;
  // Inline schedule creation fields (if linking new BE-07 schedule)
  code?: string;
  name?: string;
  targetType?: string;
  targetId?: string;
  startAt?: string;
  endAt?: string | null;
  timezone?: string;
  description?: string | null;
  status?: CleaningScheduleBindingStatus;
  createdByUserId: string;
};

export type UpdateCleaningScheduleBindingInput = {
  description?: string | null;
  status?: CleaningScheduleBindingStatus;
};

export type CleaningScheduleBindingFilter = {
  status?: CleaningScheduleBindingStatus;
  buildingId?: string;
  cleaningAreaId?: string;
  scheduleDefinitionId?: string;
};

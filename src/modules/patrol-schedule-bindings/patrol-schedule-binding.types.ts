/**
 * BE-12C — Patrol Schedule Binding domain types.
 *
 * Associates a BE-12B Patrol Route with a shared BE-07 Schedule Definition
 * under a Building context. Recurrence, occurrence preview, and task
 * generation are delegated to BE-07 without duplication.
 */
export const PATROL_SCHEDULE_BINDING_STATUSES = [
  'ACTIVE',
  'INACTIVE',
] as const;

export type PatrolScheduleBindingStatus =
  (typeof PATROL_SCHEDULE_BINDING_STATUSES)[number];

export function isPatrolScheduleBindingStatus(
  value: unknown,
): value is PatrolScheduleBindingStatus {
  return (
    typeof value === 'string' &&
    (PATROL_SCHEDULE_BINDING_STATUSES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type PatrolScheduleBindingRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  patrolRouteId: string;
  scheduleDefinitionId: string;
  startSecurityPostId: string | null;
  description: string | null;
  status: PatrolScheduleBindingStatus;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation with resolved BE-07 schedule & recurrence context. */
export type PublicPatrolScheduleBinding = {
  id: string;
  clientId: string;
  buildingId: string;
  patrolRouteId: string;
  scheduleDefinitionId: string;
  startSecurityPostId: string | null;
  description: string | null;
  status: PatrolScheduleBindingStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  patrolRoute?: {
    id: string;
    code: string;
    name: string;
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

export type CreatePatrolScheduleBindingInput = {
  patrolRouteId: string;
  scheduleDefinitionId?: string;
  startSecurityPostId?: string | null;
  // Inline schedule creation fields (if linking new BE-07 schedule)
  code?: string;
  name?: string;
  targetType?: string;
  targetId?: string;
  startAt?: string;
  endAt?: string | null;
  timezone?: string;
  description?: string | null;
  status?: PatrolScheduleBindingStatus;
  createdByUserId: string;
};

export type UpdatePatrolScheduleBindingInput = {
  startSecurityPostId?: string | null;
  description?: string | null;
  status?: PatrolScheduleBindingStatus;
};

export type PatrolScheduleBindingFilter = {
  status?: PatrolScheduleBindingStatus;
  buildingId?: string;
  patrolRouteId?: string;
  scheduleDefinitionId?: string;
};

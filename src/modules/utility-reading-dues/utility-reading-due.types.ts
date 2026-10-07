import type { UtilityType } from '../utility-meters';
export const UTILITY_READING_DUE_STATUSES = ['DUE', 'COMPLETED', 'OVERDUE', 'CANCELLED'] as const;
export type UtilityReadingDueStatus = (typeof UTILITY_READING_DUE_STATUSES)[number];
export type UtilityReadingDueRecord = {
  id: string; clientId: string; buildingId: string; meterId: string;
  utilityType: UtilityType; periodStart: Date; periodEnd: Date; dueAt: Date;
  status: UtilityReadingDueStatus; scheduleDefinitionId: string | null;
  generatedTaskId: string | null; meterReadingId: string | null;
  completedAt: Date | null; completedByUserId: string | null;
  cancelledAt: Date | null; cancelledByUserId: string | null;
  cancellationReason: string | null; createdByUserId: string;
  createdAt: Date; updatedAt: Date;
};
export type PublicUtilityReadingDue = Omit<UtilityReadingDueRecord,
  'periodStart'|'periodEnd'|'dueAt'|'completedAt'|'cancelledAt'|'createdAt'|'updatedAt'> & {
  periodStart: string; periodEnd: string; dueAt: string;
  completedAt: string | null; cancelledAt: string | null;
  createdAt: string; updatedAt: string;
};
export type CreateUtilityReadingDueInput = {
  meterId: string; periodStart: Date; periodEnd: Date; dueAt: Date;
  scheduleDefinitionId?: string | null; generatedTaskId?: string | null;
};
export type CompleteUtilityReadingDueInput = { meterReadingId: string };
export type UtilityReadingDueFilters = { status?: UtilityReadingDueStatus };

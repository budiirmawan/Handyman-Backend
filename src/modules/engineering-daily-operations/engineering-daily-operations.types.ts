import type { FindingAction } from '../findings/finding-action.types';

/**
 * BE-10A — Daily Engineering Operations read-model types.
 *
 * A lightweight consolidated daily operational view for one Building +
 * operational date (+ optional Shift). Every operation references its
 * authoritative source record (BE-07 generated task, BE-08 Work Order,
 * BE-09 Finding) — nothing is copied into a new operational master table and
 * no workflow rule is re-derived here.
 *
 * The response stays flat and light on purpose: source ids, authoritative
 * statuses, and — for Findings only — the backend-authoritative
 * `availableActions` resolved by the existing BE-09 service.
 */

export const DAILY_OPERATION_KINDS = ['TASK', 'WORK_ORDER', 'FINDING'] as const;

export type DailyOperationKind = (typeof DAILY_OPERATION_KINDS)[number];

/** Active-assignment reference resolved from the source domain's own tables. */
export type DailyOperationAssignee = {
  type: string;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
};

/** One consolidated daily operation referencing its authoritative source. */
export type PublicDailyOperation = {
  kind: DailyOperationKind;
  /** Id of the authoritative source record (task / work order / finding). */
  id: string;
  /** Source record number: schedule code / work order number / finding number. */
  referenceNumber: string | null;
  title: string;
  /** Current authoritative status from the source domain (never translated). */
  status: string;
  occurredAt: string;
  completedAt: string | null;
  assignee: DailyOperationAssignee | null;
  /**
   * BE-09 backend-authoritative available actions. Present for FINDING
   * operations only — Tasks and Work Orders expose no authoritative
   * available-actions service in their foundations.
   */
  availableActions?: FindingAction[];
};

export type PublicShiftWorkforce = {
  workforceProfileId: string;
  employeeCode: string;
  fullName: string;
};

/** Lightweight Shift context with the BE-03 workforce bound to that Shift. */
export type PublicShiftContext = {
  id: string;
  code: string;
  name: string;
  startTime: string;
  endTime: string;
  status: string;
  workforceCount: number;
  workforce: PublicShiftWorkforce[];
};

export type DailyOperationsSummary = {
  scheduled: number;
  inProgress: number;
  completed: number;
  openWorkOrders: number;
  openFindings: number;
};

export type PublicDailyEngineeringOperations = {
  buildingId: string;
  operationalDate: string;
  shift: PublicShiftContext | null;
  summary: DailyOperationsSummary;
  operations: PublicDailyOperation[];
};

export type DailyOperationsQuery = {
  buildingId: string;
  /** YYYY-MM-DD. */
  operationalDate: string;
  shiftId?: string;
};

/**
 * Task statuses counted as "scheduled" work for the operational day: generated
 * by the BE-07 scheduler and not yet started.
 */
export const SCHEDULED_TASK_STATUSES = ['OPEN', 'ASSIGNED'] as const;

/** Work Order statuses that represent open, still-actionable work (BE-08). */
export const ACTIVE_WORK_ORDER_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
] as const;

/** Work Order statuses that represent execution currently under way (BE-08). */
export const IN_PROGRESS_WORK_ORDER_STATUSES = ['IN_PROGRESS', 'ON_HOLD'] as const;

/** Finding statuses that still require operational action (BE-09). */
export const OPEN_FINDING_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'PENDING_REVIEW',
  'REWORK_REQUIRED',
  'RESUBMITTED',
] as const;

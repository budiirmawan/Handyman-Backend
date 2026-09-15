/**
 * BE-25C — Mobile Assignment Contract types.
 *
 * The unified "my assignments" feed for mobile field users: a discriminated
 * composition of the user's active Task (BE-07) and Work Order (BE-08)
 * assignments, scoped to the accessible Client/Building set (BE-02G) and
 * enriched with backend-authoritative `availableActions`.
 *
 * This is a read-model contract only — no separate mobile assignment engine
 * and no duplication of Task / Work Order / Finding / Checklist logic.
 */

import type { MobileSecurityPostSummary } from '../mobile-current-shift/mobile-current-shift.types';

export const MOBILE_ASSIGNMENT_TYPES = ['TASK', 'WORK_ORDER'] as const;

export type MobileAssignmentType = (typeof MOBILE_ASSIGNMENT_TYPES)[number];

/**
 * MOB-C04 PART 01A — Supported `shift` projection selector for
 * `GET /mobile/assignments`.
 *
 * Only `current` is supported. It selects the now-live projection (work in the
 * worker's authoritative current-shift buildings); it is purely a projection
 * selector and never carries building/shift/post authority (that stays
 * backend-derived). Any other value is rejected by the route.
 */
export const MOBILE_ASSIGNMENT_SHIFT_PROJECTIONS = ['current'] as const;

export type MobileAssignmentShiftProjection =
  (typeof MOBILE_ASSIGNMENT_SHIFT_PROJECTIONS)[number];

/** The query-mode resolved from the request for the service. */
export type MobileAssignmentProjectionMode = 'default' | 'currentShift';

/**
 * MOB-C04 PART 01 — Shift context of one field-work feed item.
 *
 * Present only when the assigned work's Building is the Building the
 * authenticated worker is currently on shift at, resolved by reusing the
 * authoritative `/mobile/current-shift` derivation (BE-03E roster +
 * BE-02F/G Building access + Building-timezone wall-clock). It is never a
 * client-computed "active shift" flag: the backend's current-shift authority
 * decides. Minimal + execution-oriented so a mobile field screen can show
 * "this work belongs to shift X" and drive the shift-scoped execution later.
 */
export type MobileAssignmentShiftContext = {
  /** `workforce_shift_assignments.id` — the authoritative roster row. */
  assignmentId: string;
  /** `shifts.id` — the authoritative Shift id. */
  shiftId: string;
  /** Shift `code` / `name` (definition fields, unchanged). */
  code: string;
  name: string;
  /** Wall-clock `HH:MM:SS` in the Building timezone. Overnight shifts are valid. */
  startTime: string;
  endTime: string;
  /**
   * Backend-assigned Security Post for this roster shift (the authoritative
   * MOB-C03 PART 03B projection). Null means no valid assigned Security Post.
   */
  securityPost: MobileSecurityPostSummary | null;
};

/** Building / Location context of the assigned work. */
export type MobileAssignmentContext = {
  clientId: string;
  buildingId: string | null;
  buildingCode: string | null;
  buildingName: string | null;
  /** Asset / functional-location references where the work is bound. */
  locations: MobileAssignmentLocation[];
};

export type MobileAssignmentLocation = {
  type: 'ASSET' | 'FUNCTIONAL_LOCATION';
  id: string;
  code: string;
  name: string;
};

/** Assignee / user / workforce context of the assignment. */
export type MobileAssignmentAssignee = {
  assigneeType: 'WORKFORCE' | 'TEAM';
  workforceProfileId: string | null;
  teamId: string | null;
  assignedByUserId: string;
  assignedAt: string;
  assignmentStatus: string;
};

/**
 * Due / schedule context. `occurrenceAt` carries the generated task's
 * schedule context; `dueAt` is always null today (no authoritative due
 * date exists for Work Orders — see BE-24 governance) and stays reserved
 * for future SLA configuration.
 */
export type MobileAssignmentSchedule = {
  occurrenceAt: string | null;
  dueAt: string | null;
};

/** Type-specific work reference (never both sides populated). */
export type MobileAssignmentReference = {
  // TASK
  taskId?: string | null;
  scheduleDefinitionId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  generatedAt?: string | null;
  // WORK_ORDER
  workOrderId?: string | null;
  workOrderNumber?: string | null;
  title?: string | null;
  description?: string | null;
  workType?: string | null;
  priority?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  completedByUserId?: string | null;
  completionSummary?: string | null;
  completionNotes?: string | null;
  createdAt?: string | null;
};

/** One mobile assignment feed item. */
export type MobileAssignmentFeedItem = {
  /** Assignment record id (task_assignments / work_order_assignments). */
  id: string;
  type: MobileAssignmentType;
  /** Current authoritative status of the work itself. */
  status: string;
  assignee: MobileAssignmentAssignee;
  context: MobileAssignmentContext;
  schedule: MobileAssignmentSchedule;
  reference: MobileAssignmentReference;
  /** Backend-authoritative actions; gated on the caller's manage permissions. */
  availableActions: string[];
  /**
   * MOB-C04 PART 01 — Shift context of this work item. Null when the item's
   * Building is not the Building the worker is currently on shift at (or the
   * work has no Building). Non-null only when the authoritative current-shift
   * derivation affirms the worker is on shift at that Building.
   */
  shift: MobileAssignmentShiftContext | null;
};

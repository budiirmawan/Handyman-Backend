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
  /**
   * CR-BE-RN12-METER-ENTRY-01 — canonical BE-18 utility reading due id.
   *
   * Exactly `utility_reading_dues.id` when this assignment's canonical
   * generated task (`task_assignments.task_id` = `generated_tasks.id`) is the
   * one linked by `utility_reading_dues.generated_task_id`. Derived purely from
   * that generated-task relation — never from `targetType` / `targetId`. Null
   * for every other assignment (including all WORK_ORDER items).
   */
  utilityReadingDueId?: string | null;
  /**
   * CR-BE-RN13-CLEANING-FIELD-01 PART 00 — canonical Cleaning Area of a
   * cleaning execution.
   *
   * Exactly `cleaning_areas.id`, derived ONLY through the generated-task
   * relation:
   *
   *   task_assignments.task_id
   *     → generated_tasks.schedule_definition_id
   *     → cleaning_schedule_bindings (status = 'ACTIVE')
   *     → cleaning_areas.id
   *
   * Migration 0352 guarantees at most one ACTIVE cleaning schedule binding per
   * schedule definition, so this resolves to exactly one Cleaning Area or to
   * none. It is never derived from `targetType` / `targetId` (those identify
   * the checklist or form template the schedule runs, not the area being
   * cleaned), nor from title / work type / asset / functional location.
   *
   * Null for every non-cleaning assignment, including all WORK_ORDER items.
   * Identity/context only — it carries no authority. `taskId` remains the
   * field execution id; task assignment and the backend's task
   * `availableActions` remain the only authority.
   */
  cleaningAreaId?: string | null;
  /**
   * CR-BE-RN16-PATROL-FIELD-01 PART 01 — canonical Patrol Execution of a
   * patrol assignment.
   *
   * Exactly `generated_tasks.id` — i.e. the same value as `taskId`, because a
   * Patrol Execution IS the BE-07 generated task (the Security view adds the
   * route/binding context under that id). Derived ONLY through the generated
   * task's schedule definition:
   *
   *   task_assignments.task_id
   *     → generated_tasks.schedule_definition_id
   *     → patrol_schedule_bindings (status = 'ACTIVE')
   *
   * Migration 0354 guarantees at most one ACTIVE patrol schedule binding per
   * schedule definition, so a task either is a patrol execution (exactly one
   * binding) or is not (none). Non-patrol assignments — including every
   * WORK_ORDER item — are null.
   *
   * It is never derived from `targetType` / `targetId` (those identify the
   * checklist or form template the schedule runs), nor from title, work type,
   * asset, functional location or security post.
   *
   * Identity/context only — it carries no authority. The backend's
   * `GET /security/patrol-executions/{id}/field-context` remains the only
   * source of the field action tokens, and it re-derives the caller's
   * authority from the building + ACTIVE task assignment itself.
   */
  patrolExecutionId?: string | null;
  /**
   * CR-BE-RN19-SAFETY-INSPECTION-01 — additive Safety Inspection marker.
   *
   * Exactly `safety_inspection_bindings.id` when the canonical generated task
   * (`task_assignments.task_id` = `generated_tasks.id`) resolves through
   * `generated_tasks.schedule_definition_id` to one ACTIVE Safety Inspection
   * binding. The backend first checks cardinality; more than one ACTIVE row is
   * a bounded ambiguity error and never selects a winner. It is never inferred
   * from target type/id, names, codes, title, or work type.
   *
   * Null for non-Safety tasks and all WORK_ORDER items. Identity/context only:
   * `taskId` remains `generated_tasks.id`, generic Checklist Execution owns
   * lifecycle/actions, and no Safety-specific actions or result authority is
   * carried here.
   */
  safetyInspectionBindingId?: string | null;
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

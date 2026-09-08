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

export const MOBILE_ASSIGNMENT_TYPES = ['TASK', 'WORK_ORDER'] as const;

export type MobileAssignmentType = (typeof MOBILE_ASSIGNMENT_TYPES)[number];

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
};

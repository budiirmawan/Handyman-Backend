import type {
  HandymanAssignmentResponseDecision,
  HandymanAssignmentResponseStatus,
} from '../assignment-responses';

/**
 * BE-08E + CR-HM-ASSIGNMENT-RESPONSE-01 PART 02A — Work Order Assignment domain
 * types.
 *
 * Assigns a Work Order to an internal Workforce Profile / Team, or to a
 * Vendor / Vendor Workforce member. The assignee masters are the existing
 * BE-03 (workforce_profiles, teams) and BE-06 (vendors,
 * vendor_workforce_bindings) tables — this module references them, never
 * duplicates them.
 *
 * Only ONE active assignment per Work Order is allowed (a partial unique
 * index over ACTIVE rows, mirroring the BE-07 task-assignment idiom). All
 * assignments are persisted; deactivation is `status: 'INACTIVE'`, never a
 * delete.
 */
export const WORK_ORDER_ASSIGNEE_TYPES = [
  'WORKFORCE',
  'TEAM',
  'VENDOR',
  'VENDOR_WORKFORCE',
] as const;

export type WorkOrderAssigneeType = (typeof WORK_ORDER_ASSIGNEE_TYPES)[number];

export function isWorkOrderAssigneeType(
  value: unknown,
): value is WorkOrderAssigneeType {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_ASSIGNEE_TYPES as readonly string[]).includes(value)
  );
}

export const WORK_ORDER_ASSIGNMENT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;

export type WorkOrderAssignmentStatus =
  (typeof WORK_ORDER_ASSIGNMENT_STATUSES)[number];

export function isWorkOrderAssignmentStatus(
  value: unknown,
): value is WorkOrderAssignmentStatus {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_ASSIGNMENT_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The Work Order lifecycle states in which an assignee may be (re)assigned.
 * Work in active states can still be (re)routed; terminal and completed
 * states cannot.
 */
export const WORK_ORDER_ASSIGNABLE_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
] as const;

export function isWorkOrderAssignableStatus(status: string): boolean {
  return (WORK_ORDER_ASSIGNABLE_STATUSES as readonly string[]).includes(status);
}

/** Full database record. */
export type WorkOrderAssignmentRecord = {
  id: string;
  workOrderId: string;
  assigneeType: WorkOrderAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
  assignedAt: Date;
  status: WorkOrderAssignmentStatus;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B2B — one RECOMMENDED gap. Handyman is a
 * MULTI-SKILL platform: a worker carries skills and certificates across
 * several trades, so a gap on a RECOMMENDED requirement is a WARNING the
 * Operations user should see, never a refusal.
 */
export type WorkOrderAssignmentCompetencyWarning = {
  workforceProfileId: string;
  workforceProfileName: string | null;
  requirementId: string;
  requirementType: 'SKILL' | 'CERTIFICATION';
  skillCode: string | null;
  certificateName: string | null;
  minimumProficiencyLevel: string | null;
  reason: string;
};

/**
 * The competency outcome of the assignment just made. `satisfied` is always
 * true on a 2xx response (a MANDATORY gap refuses the assignment), so
 * `advisory` is the only part that can be non-empty: it answers "what should
 * Operations know before sending this worker", never "may I assign".
 *
 * `competency` is present only on the assign/reassign response (where a
 * decision was just taken); plain reads of an assignment omit it.
 */
export type WorkOrderAssignmentCompetencyOutcome = {
  tradeCategoryId: string | null;
  tradeCategoryCode: string | null;
  /** ALL = every subject must qualify; ANY = at least one subject must. */
  rule: 'ALL' | 'ANY';
  satisfied: boolean;
  mandatoryRequirementCount: number;
  advisory: WorkOrderAssignmentCompetencyWarning[];
};

/**
 * Safe public representation exposed through the API.
 *
 * Combines both release lines on the same payload:
 *  - the assignment-response projection (TERIMA/TIDAK_BISA lifecycle), and
 *  - the optional competency outcome taken at assign/reassign time.
 */
export type PublicWorkOrderAssignment = {
  id: string;
  workOrderId: string;
  assigneeType: WorkOrderAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
  assignedAt: string;
  status: WorkOrderAssignmentStatus;
  responseStatus: HandymanAssignmentResponseStatus;
  respondedByUserId: string | null;
  respondedAt: string | null;
  declineReason: string | null;
  responseNotes: string | null;
  reassignmentRequired: boolean;
  competency?: WorkOrderAssignmentCompetencyOutcome | null;
};

/** Input supplied by the API consumer when assigning a Work Order. */
export type AssignWorkOrderInput = {
  workOrderId: string;
  assigneeType: WorkOrderAssigneeType;
  workforceProfileId?: string;
  teamId?: string;
  vendorId?: string;
  assignedByUserId: string;
};

/** Fully-resolved assignment data ready for persistence. */
export type NewWorkOrderAssignment = {
  workOrderId: string;
  assigneeType: WorkOrderAssigneeType;
  workforceProfileId: string | null;
  teamId: string | null;
  vendorId: string | null;
  assignedByUserId: string;
};

/** Update input (deactivate). */
export type UpdateWorkOrderAssignmentInput = {
  status: WorkOrderAssignmentStatus;
};

export type RespondToWorkOrderAssignmentInput = {
  workOrderId: string;
  assignmentId: string;
  decision: HandymanAssignmentResponseDecision;
  actorUserId: string;
  declineReason?: string;
  notes?: string;
  idempotencyKey?: string;
};

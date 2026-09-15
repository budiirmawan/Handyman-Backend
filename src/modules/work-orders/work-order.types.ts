/**
 * BE-08B/C — Work Order domain types.
 *
 * A Work Order is the formal operational work record, created directly or
 * converted from an existing Work Request (BE-08A). BE-08B established
 * identity and core metadata; BE-08C adds priority and the controlled
 * lifecycle. Asset binding, assignment, execution, evidence, completion,
 * verification, and history belong to later BE-08 PARTs.
 *
 * `work_type` is a data-driven code string (never a hardcoded
 * Engineering/Housekeeping/Security model).
 */
import type { OperationalContext } from '../structure-context';

export const WORK_ORDER_STATUSES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'COMPLETED',
  'CANCELLED',
  'CLOSED',
] as const;

export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export function isWorkOrderStatus(value: unknown): value is WorkOrderStatus {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_STATUSES as readonly string[]).includes(value)
  );
}

export const WORK_ORDER_PRIORITIES = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export type WorkOrderPriority = (typeof WORK_ORDER_PRIORITIES)[number];

/**
 * CR-BE-BAST-01 — how many accepted canonical BAST scopes this Work Order may
 * eventually require. PART 01 represents policy only; it does not gate
 * completion or closure.
 */
export const BAST_REQUIREMENTS = [
  'NONE',
  'WORK_ORDER',
  'EACH_VENDOR_WORK',
] as const;

export type BastRequirement = (typeof BAST_REQUIREMENTS)[number];

export function isBastRequirement(value: unknown): value is BastRequirement {
  return (
    typeof value === 'string' &&
    (BAST_REQUIREMENTS as readonly string[]).includes(value)
  );
}

export function isWorkOrderPriority(
  value: unknown,
): value is WorkOrderPriority {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_PRIORITIES as readonly string[]).includes(value)
  );
}

/**
 * Explicit lifecycle transition table. Terminal states (CANCELLED, CLOSED)
 * have no outgoing transitions, so reverse transitions and silent changes
 * from terminal states are rejected.
 *
 * COMPLETED has NO generic outgoing transition: it can neither reopen nor
 * close through the status endpoint. BE-08I owns the only two exits from
 * COMPLETED — rework (COMPLETED → IN_PROGRESS, via a REWORK_REQUIRED
 * verification) and closure (COMPLETED → CLOSED, only after an APPROVED
 * verification) — both applied by the verification service.
 */
export const WORK_ORDER_TRANSITIONS: Record<
  WorkOrderStatus,
  readonly WorkOrderStatus[]
> = {
  OPEN: ['ASSIGNED', 'CANCELLED'],
  ASSIGNED: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
  CLOSED: [],
};

export function canTransitionWorkOrderStatus(
  from: WorkOrderStatus,
  to: WorkOrderStatus,
): boolean {
  return (WORK_ORDER_TRANSITIONS[from] as readonly WorkOrderStatus[]).includes(
    to,
  );
}

/** Full database record. */
export type WorkOrderRecord = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderNumber: string;
  workRequestId: string | null;
  title: string;
  description: string | null;
  workType: string;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  bastRequirement: BastRequirement;
  createdByUserId: string;
  /** Optional BE-08D Asset binding. NULL = Location-only Work Order. */
  assetId: string | null;
  /** Optional BE-08D Functional Location binding. NULL = Asset-only. */
  functionalLocationId: string | null;
  assignedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  completionSummary: string | null;
  completionNotes: string | null;
  closedAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkOrder = {
  id: string;
  clientId: string;
  buildingId: string;
  workOrderNumber: string;
  workRequestId: string | null;
  title: string;
  description: string | null;
  workType: string;
  priority: WorkOrderPriority;
  status: WorkOrderStatus;
  bastRequirement: BastRequirement;
  createdByUserId: string;
  assetId: string | null;
  functionalLocationId: string | null;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionSummary: string | null;
  completionNotes: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Completion input (POST /work-orders/:id/complete). */
export type CompleteWorkOrderInput = {
  completionSummary?: string;
  completionNotes?: string;
};

/** Input for the completion service (adds the acting user). */
export type CompleteWorkOrderServiceInput = {
  workOrderId: string;
  completionSummary?: string;
  completionNotes?: string;
  actorUserId: string;
};

/** Completion readiness result. */
export type WorkOrderCompletionReadiness = {
  workOrderId: string;
  status: WorkOrderStatus;
  ready: boolean;
  requiredEvidenceSatisfied: boolean;
  missingEvidenceTypes: string[];
};

/** Input for direct Work Order creation. */
export type CreateWorkOrderInput = {
  clientId: string;
  buildingId: string;
  workOrderNumber: string;
  title: string;
  description?: string;
  workType: string;
  createdByUserId: string;
};

/** Fully-resolved Work Order data ready for persistence. */
export type NewWorkOrder = {
  clientId: string;
  buildingId: string;
  workOrderNumber: string;
  workRequestId: string | null;
  title: string;
  description: string | null;
  workType: string;
  createdByUserId: string;
};

/** Input for creating a Work Order from a Work Request. */
export type CreateWorkOrderFromRequestInput = {
  workRequestId: string;
  workOrderNumber: string;
  title: string;
  description?: string;
  workType: string;
  createdByUserId: string;
};

/** Partial update input (PATCH /work-orders/:id). */
export type UpdateWorkOrderInput = {
  title?: string;
  description?: string | null;
  workType?: string;
};

/** Priority update input (PATCH /work-orders/:id/priority). */
export type UpdateWorkOrderPriorityInput = {
  priority: WorkOrderPriority;
};

/** BAST cardinality policy update (PATCH /work-orders/:id/bast-requirement). */
export type UpdateWorkOrderBastRequirementInput = {
  bastRequirement: BastRequirement;
};

/** Status transition input (PATCH /work-orders/:id/status). */
export type UpdateWorkOrderStatusInput = {
  status: WorkOrderStatus;
};

/** List filters for GET /buildings/:buildingId/work-orders. */
export type WorkOrderFilters = {
  status?: WorkOrderStatus;
  workType?: string;
  workRequestId?: string;
};

/**
 * BE-08D — Work Order Asset / Location binding input. An explicit `null`
 * clears a binding; an omitted field leaves it unchanged. Both may be set for
 * an Asset + Location Work Order, or both cleared for a context-free one.
 */
export type UpdateWorkOrderContextInput = {
  assetId?: string | null;
  functionalLocationId?: string | null;
};

/**
 * The authoritative resolved context of a Work Order (BE-08D). The operational
 * context is projected through the BE-04H resolver, never stored.
 */
export type WorkOrderContext = {
  workOrderId: string;
  clientId: string;
  buildingId: string;
  asset:
    | {
        id: string;
        assetCode: string;
        assetName: string;
        status: string;
        functionalLocationId: string | null;
      }
    | null;
  functionalLocation:
    | {
        id: string;
        code: string;
        name: string;
        status: string;
        spaceId: string | null;
      }
    | null;
  operationalContext: OperationalContext | null;
};

import { withTransaction } from '../../database';
import { pauseResolutionClock, resumeResolutionClock, satisfyClock, terminateClocks } from '../applied-slas/sla-clock-lifecycle.service';
import { workforceRepository } from '../workforce';
import { vendorWorkforceRepository } from '../vendor-workforce';
import { workOrderAssignmentRepository } from '../work-order-assignments';
import type { WorkOrderAssignmentRecord } from '../work-order-assignments';
import { recordWorkOrderEvent } from '../work-order-history';
import {
  workOrderNotFoundError,
  workOrderRepository,
  type WorkOrderRecord,
  type WorkOrderStatus,
} from '../work-orders';
import {
  workOrderExecutionInvalidStateError,
  workOrderExecutionNoAssignmentError,
  workOrderExecutionUnauthorizedError,
} from './work-order-action.errors';
import { workOrderActionRepository } from './work-order-action.repository';
import {
  type PublicWorkOrderAction,
  type RecordWorkOrderActionInput,
  type WorkOrderActionRecord,
  type WorkOrderActionType,
  WORK_ORDER_ACTION_TYPES,
  WORK_ORDER_EXECUTION_ACTIONS,
  type WorkOrderAvailableAction,
  type WorkOrderExecutionAction,
} from './work-order-action.types';

const ACTIVE_STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'] as const;

type ActionRule = {
  requiredStatuses: readonly WorkOrderStatus[];
  requiresAssignment: boolean;
  nextStatus: WorkOrderStatus | null;
};

const ACTION_RULES: Record<WorkOrderActionType, ActionRule> = {
  ACKNOWLEDGED: {
    requiredStatuses: ['OPEN', 'ASSIGNED'],
    requiresAssignment: true,
    // Acknowledging an OPEN assignment confirms it (OPEN → ASSIGNED).
    nextStatus: 'ASSIGNED',
  },
  STARTED: {
    requiredStatuses: ['ASSIGNED'],
    requiresAssignment: true,
    nextStatus: 'IN_PROGRESS',
  },
  ON_HOLD: {
    requiredStatuses: ['IN_PROGRESS'],
    requiresAssignment: true,
    nextStatus: 'ON_HOLD',
  },
  RESUMED: {
    requiredStatuses: ['ON_HOLD'],
    requiresAssignment: true,
    nextStatus: 'IN_PROGRESS',
  },
  NOTE_ADDED: {
    requiredStatuses: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'],
    requiresAssignment: true,
    nextStatus: null,
  },
  CANCELLED: {
    requiredStatuses: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD'],
    // Cancellation is a management action; no active assignment required.
    requiresAssignment: false,
    nextStatus: 'CANCELLED',
  },
};

export function toPublicWorkOrderAction(
  record: WorkOrderActionRecord,
): PublicWorkOrderAction {
  return {
    id: record.id,
    workOrderId: record.workOrderId,
    actionType: record.actionType,
    actorUserId: record.actorUserId,
    notes: record.notes,
    occurredAt: record.occurredAt.toISOString(),
  };
}

/**
 * Returns true when the acting user is the assignee (or a member of the
 * assigned team / bound to the assigned vendor) of the given active
 * assignment. The actor's Workforce Profile is the authority, linked to the
 * User through `workforce_profiles.user_id`.
 *
 * Exported (CR-BE-RN11-MATERIAL-FIELD-01 PART 01) as the single Work Order
 * field-authorization seam so field commands outside this module reuse the
 * exact BE-08F rule instead of a weaker copy. Behavior unchanged.
 */
export async function isActorAuthorizedForWorkOrderAssignment(
  actorUserId: string,
  assignment: WorkOrderAssignmentRecord,
): Promise<boolean> {
  const profile = await workforceRepository.findByUserId(actorUserId);
  if (!profile) {
    return false;
  }

  switch (assignment.assigneeType) {
    case 'WORKFORCE':
      return profile.id === assignment.workforceProfileId;
    case 'TEAM':
      return profile.teamId !== null && profile.teamId === assignment.teamId;
    case 'VENDOR':
      return (
        assignment.vendorId !== null &&
        (await vendorWorkforceRepository.findActiveByVendorAndWorkforce(
          assignment.vendorId,
          profile.id,
        )) !== null
      );
    case 'VENDOR_WORKFORCE':
      return profile.id === assignment.workforceProfileId;
  }
}

async function loadWorkOrder(workOrderId: string): Promise<WorkOrderRecord> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  return workOrder;
}

async function loadActiveAssignment(
  workOrderId: string,
): Promise<WorkOrderAssignmentRecord | null> {
  return workOrderAssignmentRepository.findActiveByWorkOrderId(workOrderId);
}

/**
 * CR-BE-RN11-MATERIAL-FIELD-01 PART 01 — "is this actor currently authorized
 * to perform field work on this Work Order?" Exactly the BE-08F execution
 * gate (steps 2–3 of `recordWorkOrderAction`):
 *   no active assignment → 400 WORK_ORDER_EXECUTION_NO_ASSIGNMENT
 *   actor not assignee   → 403 WORK_ORDER_EXECUTION_UNAUTHORIZED
 */
export async function assertWorkOrderFieldActor(
  workOrderId: string,
  actorUserId: string,
): Promise<WorkOrderAssignmentRecord> {
  const assignment = await loadActiveAssignment(workOrderId);
  if (!assignment) {
    throw workOrderExecutionNoAssignmentError();
  }
  if (!(await isActorAuthorizedForWorkOrderAssignment(actorUserId, assignment))) {
    throw workOrderExecutionUnauthorizedError();
  }
  return assignment;
}

/**
 * Records an execution action, reusing the BE-08C lifecycle transition engine
 * and the BE-08E active assignment for validation.
 *
 * Validation order (pinned by tests):
 *   1. unknown Work Order         → 404 WORK_ORDER_NOT_FOUND
 *   2. no active assignment       → 400 WORK_ORDER_EXECUTION_NO_ASSIGNMENT
 *                                   (for assignment-requiring actions)
 *   3. actor not authorized       → 403 WORK_ORDER_EXECUTION_UNAUTHORIZED
 *   4. action invalid for state   → 400 WORK_ORDER_EXECUTION_INVALID_STATE
 *   5. lifecycle transition fail  → 400 WORK_ORDER_INVALID_TRANSITION
 */
export async function recordWorkOrderAction(
  input: RecordWorkOrderActionInput,
): Promise<PublicWorkOrderAction> {
  const workOrder = await loadWorkOrder(input.workOrderId);
  const rule = ACTION_RULES[input.actionType];

  if (rule.requiresAssignment) {
    const assignment = await loadActiveAssignment(input.workOrderId);
    if (!assignment) {
      throw workOrderExecutionNoAssignmentError();
    }
    if (!(await isActorAuthorizedForWorkOrderAssignment(input.actorUserId, assignment))) {
      throw workOrderExecutionUnauthorizedError();
    }
  }

  if (!(rule.requiredStatuses as readonly string[]).includes(workOrder.status)) {
    throw workOrderExecutionInvalidStateError();
  }

  // The existing action is the authoritative hold/resume signal. Persist its
  // lifecycle transition, action timestamp, and SLA side effect atomically.
  const record = await withTransaction(async (tx) => {
    if (rule.nextStatus !== null && rule.nextStatus !== workOrder.status) {
      await workOrderRepository.updateStatus(workOrder.id, rule.nextStatus, tx);
    }
    const action = await workOrderActionRepository.create({
      workOrderId: workOrder.id,
      actionType: input.actionType,
      actorUserId: input.actorUserId,
      notes: input.notes?.trim() || null,
    }, tx);
    if (input.actionType === 'ON_HOLD') {
      await pauseResolutionClock(workOrder, action.occurredAt, input.actorUserId, tx);
    } else if (input.actionType === 'RESUMED') {
      await resumeResolutionClock(workOrder, action.occurredAt, input.actorUserId, tx);
    } else if (input.actionType === 'ACKNOWLEDGED') {
      await satisfyClock(workOrder, 'RESPONSE', action.occurredAt, tx);
    } else if (input.actionType === 'CANCELLED') {
      await terminateClocks(workOrder, action.occurredAt, tx);
    }
    return action;
  });
  if (rule.nextStatus !== null && rule.nextStatus !== workOrder.status) {
    await recordWorkOrderEvent({workOrderId:workOrder.id,clientId:workOrder.clientId,buildingId:workOrder.buildingId,eventType:'WORK_ORDER_STATUS_CHANGED',summary:`Work order status changed from ${workOrder.status} to ${rule.nextStatus}`,metadata:{from:workOrder.status,to:rule.nextStatus}});
  }
  await recordWorkOrderEvent({
    workOrderId: workOrder.id,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    eventType: 'WORK_ORDER_EXECUTION_ACTION',
    actorUserId: input.actorUserId,
    summary: `Work order execution action: ${input.actionType}`,
    metadata: { actionType: input.actionType },
  });
  return toPublicWorkOrderAction(record);
}

const ACTION_TO_EXECUTION_ACTION: Record<
  WorkOrderActionType,
  WorkOrderExecutionAction
> = {
  ACKNOWLEDGED: 'ACKNOWLEDGE',
  STARTED: 'START',
  ON_HOLD: 'HOLD',
  RESUMED: 'RESUME',
  NOTE_ADDED: 'ADD_NOTE',
  CANCELLED: 'CANCEL',
};

/**
 * BE-25C — Backend-authoritative available execution actions for a Work
 * Order, resolved from the same `ACTION_RULES` the execution endpoints
 * enforce. `hasActiveAssignment`/`isActorAuthorized` reflect the BE-08E
 * assignment authority (the mobile feed passes true for the caller's own
 * assignments; the execution endpoints enforce it directly). `canClose` is
 * resolved separately by the Work Order closure authority so execution rules
 * remain unchanged.
 *
 * CR-BE-MOBILE-WO-COMPLETE-01 — `COMPLETE` is appended on the conditions the
 * resolver already represents: the Work Order is IN_PROGRESS and the caller
 * holds the assignment authority the BE-08H completion command requires. It
 * marks the existing completion command, whose endpoint remains
 * `POST /work-orders/:id/complete`; `CLOSE` stays a separate token for the
 * separate COMPLETED → CLOSED closure command.
 *
 * Required-evidence readiness is deliberately NOT consulted here. Evidence
 * validation stays inside `completeWorkOrder` (the single authority), so this
 * resolver performs no evidence query and adds no N+1 read: `COMPLETE` may be
 * visible while required evidence is still incomplete, and attempting the
 * completion command still returns the canonical
 * `WORK_ORDER_COMPLETION_EVIDENCE_INCOMPLETE` error with `missingEvidenceTypes`.
 */
export function resolveWorkOrderAvailableActions(
  workOrderStatus: WorkOrderStatus,
  hasActiveAssignment: boolean,
  isActorAuthorized: boolean,
  canClose = false,
): WorkOrderAvailableAction[] {
  const actions: WorkOrderAvailableAction[] = [];
  for (const type of WORK_ORDER_ACTION_TYPES) {
    const rule = ACTION_RULES[type];
    if (!(rule.requiredStatuses as readonly string[]).includes(workOrderStatus)) {
      continue;
    }
    if (rule.requiresAssignment && (!hasActiveAssignment || !isActorAuthorized)) {
      continue;
    }
    actions.push(ACTION_TO_EXECUTION_ACTION[type]);
  }
  if (
    workOrderStatus === 'IN_PROGRESS' &&
    hasActiveAssignment &&
    isActorAuthorized
  ) {
    actions.push('COMPLETE');
  }
  if (canClose && workOrderStatus === 'COMPLETED') {
    actions.push('CLOSE');
  }
  return actions;
}

/** Lists the execution actions of a Work Order in occurred order. */
export async function listWorkOrderActions(
  workOrderId: string,
): Promise<PublicWorkOrderAction[]> {
  await loadWorkOrder(workOrderId);
  const records = await workOrderActionRepository.listByWorkOrderId(workOrderId);
  return records.map(toPublicWorkOrderAction);
}

export const workOrderActionService = {
  listWorkOrderActions,
  recordWorkOrderAction,
  resolveWorkOrderAvailableActions,
  toPublicWorkOrderAction,
};

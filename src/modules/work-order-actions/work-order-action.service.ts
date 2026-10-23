import { withTransaction } from '../../database';
import {
  pauseResolutionClock,
  resumeResolutionClock,
  satisfyClock,
  terminateClocks,
} from '../applied-slas/sla-clock-lifecycle.service';
import {
  assignmentAlreadyDeclinedError,
  assignmentResponseConflictError,
  assignmentResponseRepository,
  notifyWorkOrderAssignmentAccepted,
  type HandymanAssignmentResponseStatus,
} from '../assignment-responses';
import { vendorWorkforceRepository } from '../vendor-workforce';
import {
  workOrderAssignmentRepository,
  type WorkOrderAssignmentRecord,
} from '../work-order-assignments';
import { recordWorkOrderEvent } from '../work-order-history';
import {
  workOrderNotFoundError,
  workOrderRepository,
  type WorkOrderRecord,
  type WorkOrderStatus,
} from '../work-orders';
import { workforceRepository } from '../workforce';
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
  type WorkOrderAvailableAction,
  type WorkOrderExecutionAction,
} from './work-order-action.types';

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
  if (
    !(await isActorAuthorizedForWorkOrderAssignment(actorUserId, assignment))
  ) {
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
 *   4. declined / unaccepted gate → 409 WORK_ORDER_ASSIGNMENT_DECLINED /
 *                                   409 WORK_ORDER_ASSIGNMENT_RESPONSE_CONFLICT
 *   5. action invalid for state   → 400 WORK_ORDER_EXECUTION_INVALID_STATE
 *   6. lifecycle transition fail  → 400 WORK_ORDER_INVALID_TRANSITION
 */
export async function recordWorkOrderAction(
  input: RecordWorkOrderActionInput,
): Promise<PublicWorkOrderAction> {
  const workOrder = await loadWorkOrder(input.workOrderId);
  const rule = ACTION_RULES[input.actionType];

  let activeAssignment: WorkOrderAssignmentRecord | null = null;
  if (rule.requiresAssignment) {
    activeAssignment = await loadActiveAssignment(input.workOrderId);
    if (!activeAssignment) {
      throw workOrderExecutionNoAssignmentError();
    }
    if (
      !(await isActorAuthorizedForWorkOrderAssignment(
        input.actorUserId,
        activeAssignment,
      ))
    ) {
      throw workOrderExecutionUnauthorizedError();
    }

    const currentResponse =
      await assignmentResponseRepository.ensurePendingForAssignment({
        clientId: workOrder.clientId,
        buildingId: workOrder.buildingId,
        assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
        assignmentId: activeAssignment.id,
        workOrderId: workOrder.id,
        assignedByUserId: activeAssignment.assignedByUserId,
        assignedAt: activeAssignment.assignedAt,
      });

    if (currentResponse.responseStatus === 'TIDAK_BISA') {
      if (input.actionType === 'ACKNOWLEDGED') {
        throw assignmentResponseConflictError(
          'Cannot acknowledge a Work Order whose active assignment was declined (TIDAK_BISA).',
        );
      }
      if (
        input.actionType === 'STARTED' ||
        input.actionType === 'ON_HOLD' ||
        input.actionType === 'RESUMED'
      ) {
        throw assignmentAlreadyDeclinedError(
          'Cannot execute work on a Work Order whose active assignment was declined (TIDAK_BISA).',
        );
      }
    }

    // If a Work Order is in ASSIGNED status after reassignment (where a
    // previous assignment had been acknowledged), the new assignee must still
    // accept (TERIMA / ACKNOWLEDGE) their own active assignment before START.
    if (
      input.actionType === 'STARTED' &&
      workOrder.status === 'ASSIGNED' &&
      currentResponse.responseStatus === 'PENDING'
    ) {
      const allAssignments =
        await workOrderAssignmentRepository.listByWorkOrderId(workOrder.id);
      const hasPriorSupersededAssignment = allAssignments.some(
        (entry) => entry.id !== activeAssignment!.id && entry.status === 'INACTIVE',
      );
      if (hasPriorSupersededAssignment) {
        throw workOrderExecutionInvalidStateError();
      }
    }
  }

  if (!(rule.requiredStatuses as readonly string[]).includes(workOrder.status)) {
    throw workOrderExecutionInvalidStateError();
  }

  // Persist lifecycle transition, action timestamp, assignment response state
  // (for ACKNOWLEDGED), operational events, notifications, and SLA side
  // effects atomically inside a single transaction.
  const record = await withTransaction(async (tx) => {
    if (input.actionType === 'ACKNOWLEDGED' && activeAssignment) {
      const lockedResponse =
        await assignmentResponseRepository.ensurePendingForAssignment(
          {
            clientId: workOrder.clientId,
            buildingId: workOrder.buildingId,
            assignmentTargetType: 'WORK_ORDER_ASSIGNMENT',
            assignmentId: activeAssignment.id,
            workOrderId: workOrder.id,
            assignedByUserId: activeAssignment.assignedByUserId,
            assignedAt: activeAssignment.assignedAt,
          },
          tx,
          true,
        );

      if (lockedResponse.responseStatus === 'TIDAK_BISA') {
        throw assignmentResponseConflictError(
          'Cannot acknowledge a Work Order whose active assignment was declined (TIDAK_BISA).',
        );
      }

      if (lockedResponse.responseStatus === 'TERIMA') {
        if (lockedResponse.linkedWorkOrderActionId) {
          const existingAction = await workOrderActionRepository.findById(
            lockedResponse.linkedWorkOrderActionId,
            tx,
          );
          if (existingAction) {
            return existingAction;
          }
        }
        const actions = await workOrderActionRepository.listByWorkOrderId(
          workOrder.id,
          tx,
        );
        const latestAck = [...actions]
          .reverse()
          .find((a) => a.actionType === 'ACKNOWLEDGED');
        if (latestAck) {
          return latestAck;
        }
      }
    }

    if (rule.nextStatus !== null && rule.nextStatus !== workOrder.status) {
      await workOrderRepository.updateStatus(workOrder.id, rule.nextStatus, tx);
    }

    const action = await workOrderActionRepository.create(
      {
        workOrderId: workOrder.id,
        actionType: input.actionType,
        actorUserId: input.actorUserId,
        notes: input.notes?.trim() || null,
      },
      tx,
    );

    if (input.actionType === 'ON_HOLD') {
      await pauseResolutionClock(
        workOrder,
        action.occurredAt,
        input.actorUserId,
        tx,
      );
    } else if (input.actionType === 'RESUMED') {
      await resumeResolutionClock(
        workOrder,
        action.occurredAt,
        input.actorUserId,
        tx,
      );
    } else if (input.actionType === 'ACKNOWLEDGED') {
      await satisfyClock(workOrder, 'RESPONSE', action.occurredAt, tx);
      if (activeAssignment) {
        await assignmentResponseRepository.recordDecision(
          {
            assignmentId: activeAssignment.id,
            decision: 'TERIMA',
            actorUserId: input.actorUserId,
            respondedAt: action.occurredAt,
            notes: action.notes,
            linkedWorkOrderActionId: action.id,
          },
          tx,
        );
        await notifyWorkOrderAssignmentAccepted(
          workOrder,
          activeAssignment,
          input.actorUserId,
          action.occurredAt,
          tx,
        );
      }
    } else if (input.actionType === 'CANCELLED') {
      await terminateClocks(workOrder, action.occurredAt, tx);
    }

    if (rule.nextStatus !== null && rule.nextStatus !== workOrder.status) {
      await recordWorkOrderEvent(
        {
          workOrderId: workOrder.id,
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          eventType: 'WORK_ORDER_STATUS_CHANGED',
          summary: `Work order status changed from ${workOrder.status} to ${rule.nextStatus}`,
          metadata: { from: workOrder.status, to: rule.nextStatus },
        },
        tx,
      );
    }

    await recordWorkOrderEvent(
      {
        workOrderId: workOrder.id,
        clientId: workOrder.clientId,
        buildingId: workOrder.buildingId,
        eventType: 'WORK_ORDER_EXECUTION_ACTION',
        actorUserId: input.actorUserId,
        summary: `Work order execution action: ${input.actionType}`,
        metadata: { actionType: input.actionType },
      },
      tx,
    );

    return action;
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
 */
export function resolveWorkOrderAvailableActions(
  workOrderStatus: WorkOrderStatus,
  hasActiveAssignment: boolean,
  isActorAuthorized: boolean,
  canClose = false,
  assignmentResponseStatus?: HandymanAssignmentResponseStatus,
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
    if (
      assignmentResponseStatus === 'TIDAK_BISA' &&
      (type === 'ACKNOWLEDGED' || type === 'STARTED')
    ) {
      continue;
    }
    actions.push(ACTION_TO_EXECUTION_ACTION[type]);
  }
  if (
    workOrderStatus === 'IN_PROGRESS' &&
    hasActiveAssignment &&
    isActorAuthorized &&
    assignmentResponseStatus !== 'TIDAK_BISA'
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

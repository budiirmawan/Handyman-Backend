/**
 * BE-08F — Work Order Execution Action domain types.
 *
 * An execution action is a lightweight, append-only record of a generic Work
 * Order action (acknowledge, start, hold, resume, note, cancel). Lifecycle
 * rules are enforced by reusing the BE-08C transition engine
 * (`workOrderService.transitionWorkOrderStatus`), and assignment authorization
 * reuses the BE-08E active assignment. No Engineering-, Housekeeping-, or
 * Security-specific execution logic lives here.
 */
export const WORK_ORDER_ACTION_TYPES = [
  'ACKNOWLEDGED',
  'STARTED',
  'ON_HOLD',
  'RESUMED',
  'NOTE_ADDED',
  'CANCELLED',
] as const;

export type WorkOrderActionType = (typeof WORK_ORDER_ACTION_TYPES)[number];

/**
 * BE-25C — User-facing execution action codes exposed by the mobile
 * assignment feed (one-to-one with the action endpoints).
 */
export const WORK_ORDER_EXECUTION_ACTIONS = [
  'ACKNOWLEDGE',
  'START',
  'HOLD',
  'RESUME',
  'ADD_NOTE',
  'CANCEL',
] as const;

export type WorkOrderExecutionAction = (typeof WORK_ORDER_EXECUTION_ACTIONS)[number];
export type WorkOrderAvailableAction = WorkOrderExecutionAction | 'CLOSE';

export function isWorkOrderActionType(
  value: unknown,
): value is WorkOrderActionType {
  return (
    typeof value === 'string' &&
    (WORK_ORDER_ACTION_TYPES as readonly string[]).includes(value)
  );
}

/** Full database record. */
export type WorkOrderActionRecord = {
  id: string;
  workOrderId: string;
  actionType: WorkOrderActionType;
  actorUserId: string;
  notes: string | null;
  occurredAt: Date;
  createdAt: Date;
};

/** Safe public representation exposed through the API. */
export type PublicWorkOrderAction = {
  id: string;
  workOrderId: string;
  actionType: WorkOrderActionType;
  actorUserId: string;
  notes: string | null;
  occurredAt: string;
};

/** Input for recording an execution action. */
export type RecordWorkOrderActionInput = {
  workOrderId: string;
  actionType: WorkOrderActionType;
  actorUserId: string;
  notes?: string;
};

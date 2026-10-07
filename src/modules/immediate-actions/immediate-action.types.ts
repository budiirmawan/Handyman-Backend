import type { IncidentStatus, IncidentType } from '../incidents';

/**
 * BE-21E — Immediate Action domain types.
 *
 * An Immediate Action is the lightweight containment response to a BE-21A
 * Incident of ANY type. It is a CHILD of the Incident (many per Incident with
 * its own id), not a 1:1 specialization like BE-21B/C/D.
 *
 * It is deliberately NOT Investigation (BE-21F) and NOT Corrective Action
 * (BE-21G). What is absent says so: no root cause, no corrective plan, no
 * verification, no closure, no due date, no assignment workflow.
 * `responsibleUserId` records who DID the containment, not a tracked
 * assignment.
 */

/**
 * The controlled containment vocabulary. A closed list (mirrored by a DB
 * CHECK) so response reporting stays meaningful; `OTHER` is the escape hatch.
 */
export const IMMEDIATE_ACTION_TYPES = [
  'CONTAINMENT',
  'ISOLATION',
  'SHUTDOWN',
  'EVACUATION',
  'BARRICADE',
  'TEMPORARY_REPAIR',
  'CLEANUP',
  'NOTIFICATION',
  'FIRST_AID',
  'OTHER',
] as const;

export type ImmediateActionType = (typeof IMMEDIATE_ACTION_TYPES)[number];

export function isImmediateActionType(
  value: unknown,
): value is ImmediateActionType {
  return (
    typeof value === 'string' &&
    (IMMEDIATE_ACTION_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Action progression. `CANCELLED` here means the action itself was abandoned
 * (e.g. containment proved unnecessary) — it is NOT the Incident's
 * cancellation, which lives on BE-21A and is a different thing entirely.
 *
 * Both `COMPLETED` and `CANCELLED` are terminal: an immediate action is a
 * point-in-time containment record, so re-opening one would falsify history.
 * If containment must resume, that is a NEW action, which is exactly why this
 * is a child collection rather than a single row per Incident.
 */
export const IMMEDIATE_ACTION_STATUSES = [
  'PLANNED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

export type ImmediateActionStatus =
  (typeof IMMEDIATE_ACTION_STATUSES)[number];

export function isImmediateActionStatus(
  value: unknown,
): value is ImmediateActionStatus {
  return (
    typeof value === 'string' &&
    (IMMEDIATE_ACTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The explicit, closed transition table — a small lookup, NOT a workflow
 * engine and not a copy of BE-09's.
 *
 *   PLANNED     → IN_PROGRESS, COMPLETED, CANCELLED
 *   IN_PROGRESS → COMPLETED, CANCELLED
 *   COMPLETED   → (terminal)
 *   CANCELLED   → (terminal)
 *
 * PLANNED → COMPLETED is allowed directly: containment is often recorded after
 * the fact, in one step.
 */
export const IMMEDIATE_ACTION_TRANSITIONS: Record<
  ImmediateActionStatus,
  readonly ImmediateActionStatus[]
> = {
  PLANNED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionImmediateActionStatus(
  from: ImmediateActionStatus,
  to: ImmediateActionStatus,
): boolean {
  return IMMEDIATE_ACTION_TRANSITIONS[from].includes(to);
}

export function isTerminalImmediateActionStatus(
  status: ImmediateActionStatus,
): boolean {
  return IMMEDIATE_ACTION_TRANSITIONS[status].length === 0;
}

/**
 * Backend-authoritative actions, computed per request from state × permission
 * × the Incident lifecycle. Never persisted, never recomputed by the client.
 */
export const IMMEDIATE_ACTION_ACTIONS = [
  'START_PROGRESS',
  'COMPLETE',
  'CANCEL',
  'UPDATE_DETAILS',
] as const;

export type ImmediateActionAction =
  (typeof IMMEDIATE_ACTION_ACTIONS)[number];

/**
 * The single source of truth linking a legal transition to the action that
 * offers it, so a permitted transition can never become undiscoverable and an
 * advertised action can never be rejected on execution.
 */
export const IMMEDIATE_ACTION_TRANSITION_ACTIONS: {
  readonly [From in ImmediateActionStatus]: {
    readonly [To in ImmediateActionStatus]?: ImmediateActionAction;
  };
} = {
  PLANNED: {
    IN_PROGRESS: 'START_PROGRESS',
    COMPLETED: 'COMPLETE',
    CANCELLED: 'CANCEL',
  },
  IN_PROGRESS: { COMPLETED: 'COMPLETE', CANCELLED: 'CANCEL' },
  COMPLETED: {},
  CANCELLED: {},
};

/** Status-driven actions (permission and lifecycle gating happen upstream). */
export function immediateActionTransitionActions(
  from: ImmediateActionStatus,
): ImmediateActionAction[] {
  return IMMEDIATE_ACTION_TRANSITIONS[from].map((to) => {
    const action = IMMEDIATE_ACTION_TRANSITION_ACTIONS[from][to];
    if (!action) {
      throw new Error(
        `Immediate Action transition ${from} → ${to} has no action mapping`,
      );
    }
    return action;
  });
}

/** The row exactly as persisted. */
export type ImmediateActionRecord = {
  id: string;
  incidentId: string;
  actionType: ImmediateActionType;
  description: string;
  status: ImmediateActionStatus;
  takenAt: Date;
  /** Who performed the containment; NOT a tracked assignment (see BE-21H). */
  responsibleUserId: string | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  statusChangedAt: Date;
  notes: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The joined row: the action plus the BE-21A Incident context it RESOLVES
 * through the FK. Incident fields are read, never stored here.
 */
export type ImmediateActionCompositeRecord = ImmediateActionRecord & {
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  incidentStatus: IncidentStatus;
};

/** Safe public representation. */
export type PublicImmediateAction = {
  /** The Immediate Action's OWN id — this is a child, not a specialization. */
  id: string;
  incidentId: string;
  /** Resolved Incident context, projected read-only from BE-21A. */
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  incidentStatus: IncidentStatus;
  actionType: ImmediateActionType;
  description: string;
  status: ImmediateActionStatus;
  takenAt: string;
  responsibleUserId: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  statusChangedAt: string;
  notes: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  /** Backend-resolved; the frontend must not recompute these. */
  availableActions: ImmediateActionAction[];
};

/**
 * Creation input.
 *
 * `clientId` / `buildingId` are absent by design: the Incident already knows
 * its context, and re-accepting them would let a caller assert a context that
 * contradicts BE-21A. `status` is absent too — a new action always starts
 * PLANNED and moves through the transition table.
 */
export type CreateImmediateActionInput = {
  incidentId: string;
  actionType: ImmediateActionType;
  description: string;
  takenAt: Date;
  responsibleUserId?: string | null;
  notes?: string | null;
};

export type NewImmediateAction = {
  incidentId: string;
  actionType: ImmediateActionType;
  description: string;
  takenAt: Date;
  responsibleUserId: string | null;
  notes: string | null;
  createdByUserId: string;
};

/**
 * `incidentId` is absent by design: re-parenting an action to another Incident
 * would rewrite history. `status` is absent because completion is an explicit
 * operation with its own metadata, not a field assignment.
 */
export type UpdateImmediateActionInput = {
  actionType?: ImmediateActionType;
  description?: string;
  takenAt?: Date;
  responsibleUserId?: string | null;
  notes?: string | null;
};

/** Completion carries its own metadata, preserved on the row. */
export type CompleteImmediateActionInput = {
  completionNotes?: string | null;
  completedAt?: Date;
};

export type ImmediateActionFilters = {
  incidentId?: string;
  buildingId?: string;
  actionType?: ImmediateActionType;
  status?: ImmediateActionStatus;
  responsibleUserId?: string;
  incidentStatus?: IncidentStatus;
  incidentType?: IncidentType;
  takenFrom?: Date;
  takenTo?: Date;
};

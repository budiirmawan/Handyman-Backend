import type { IncidentStatus, IncidentType } from '../incidents';

/**
 * BE-21G — Corrective Action domain types.
 *
 * A Corrective Action is the durable fix that stops a BE-21A Incident
 * recurring. Like BE-21E it is a CHILD of the Incident (many per Incident,
 * each with its own id), not a 1:1 specialization.
 *
 * IT IS NOT AN IMMEDIATE ACTION AT A LATER STAGE
 * ----------------------------------------------
 * BE-21E records containment ALREADY TAKEN — recorded after the fact, with a
 * past `takenAt` and no approval. BE-21G proposes remedial work for the
 * FUTURE, which must be approved before it is executed. The lifecycles differ
 * for that reason, and collapsing them would lose the approval decision.
 *
 * DELIBERATELY ABSENT: `responsibleUserId` and any due/target date. Those are
 * BE-21H and BE-21I. Verification (BE-21J) and closure (BE-21K) are absent
 * too — COMPLETED is terminal in this PART and a later one may extend past it.
 */

/**
 * The controlled remedy vocabulary — a closed list mirrored by a DB CHECK, so
 * corrective-action reporting stays comparable across an estate. `OTHER` is
 * the escape hatch.
 */
export const CORRECTIVE_ACTION_TYPES = [
  'REPAIR',
  'REPLACEMENT',
  'PROCESS_CHANGE',
  'TRAINING',
  'MAINTENANCE_PLAN_UPDATE',
  'DESIGN_CHANGE',
  'POLICY_UPDATE',
  'INSPECTION_REGIME',
  'VENDOR_ACTION',
  'OTHER',
] as const;

export type CorrectiveActionType = (typeof CORRECTIVE_ACTION_TYPES)[number];

export function isCorrectiveActionType(
  value: unknown,
): value is CorrectiveActionType {
  return (
    typeof value === 'string' &&
    (CORRECTIVE_ACTION_TYPES as readonly string[]).includes(value)
  );
}

/**
 * The corrective lifecycle. Remedial work is PROPOSED, then approved or
 * rejected, then executed.
 *
 * `REJECTED` (the proposal was refused) and `CANCELLED` (approved work called
 * off) are distinct terminal outcomes, not synonyms — conflating them would
 * lose whether the remedy was ever agreed to.
 */
export const CORRECTIVE_ACTION_STATUSES = [
  'PROPOSED',
  'APPROVED',
  'IN_PROGRESS',
  'COMPLETED',
  // BE-21J. COMPLETED is a CLAIM by the doer; VERIFIED is independent
  // confirmation that the remedy actually holds. Keeping them distinct is the
  // whole point of verification — collapsing them would make "done" and
  // "checked" the same assertion by the same party.
  'VERIFIED',
  'REJECTED',
  'CANCELLED',
] as const;

export type CorrectiveActionStatus =
  (typeof CORRECTIVE_ACTION_STATUSES)[number];

export function isCorrectiveActionStatus(
  value: unknown,
): value is CorrectiveActionStatus {
  return (
    typeof value === 'string' &&
    (CORRECTIVE_ACTION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The explicit, closed transition table — a small lookup, NOT a workflow
 * engine and not a copy of BE-09's.
 *
 *   PROPOSED    → APPROVED, REJECTED, CANCELLED
 *   APPROVED    → IN_PROGRESS, COMPLETED, CANCELLED
 *   IN_PROGRESS → COMPLETED, CANCELLED
 *   COMPLETED   → (terminal)
 *   REJECTED    → (terminal)
 *   CANCELLED   → (terminal)
 *
 * PROPOSED cannot jump straight to COMPLETED: unlike containment, remedial
 * work must be agreed before it counts as done. APPROVED → COMPLETED is
 * allowed, since short fixes are often approved and finished in one step.
 *
 * A rejected proposal is terminal rather than re-openable — reviving it would
 * erase the record of the refusal. Superseding it is a NEW proposal, which is
 * exactly why this is a child collection.
 */
export const CORRECTIVE_ACTION_TRANSITIONS: Record<
  CorrectiveActionStatus,
  readonly CorrectiveActionStatus[]
> = {
  PROPOSED: ['APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['IN_PROGRESS', 'COMPLETED', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  // BE-21J. COMPLETED is no longer terminal: it now awaits verification,
  // which either confirms it (VERIFIED) or sends it back (IN_PROGRESS).
  // Both moves are made by the VERIFICATION endpoints — never by a caller
  // asserting the status directly — so the confirmation is always backed by
  // a recorded decision in the shared reviews table.
  COMPLETED: ['VERIFIED', 'IN_PROGRESS'],
  VERIFIED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransitionCorrectiveActionStatus(
  from: CorrectiveActionStatus,
  to: CorrectiveActionStatus,
): boolean {
  return CORRECTIVE_ACTION_TRANSITIONS[from].includes(to);
}

/** No transitions remain: the row will never move again. */
export function isTerminalCorrectiveActionStatus(
  status: CorrectiveActionStatus,
): boolean {
  return CORRECTIVE_ACTION_TRANSITIONS[status].length === 0;
}

/**
 * BE-21J — the work is no longer in flight.
 *
 * TERMINAL AND SETTLED ARE NOT THE SAME THING, and conflating them is the
 * subtle bug this PART could easily have introduced. Before BE-21J they
 * happened to coincide, so a single `isTerminal` check served both meanings.
 * Now COMPLETED is settled (the doer has downed tools) but NOT terminal (it
 * still awaits a verification decision).
 *
 * Everything that asks "is this work finished?" must use THIS predicate:
 *   - the deadline verdict (a completed action is MET/MISSED, never OVERDUE),
 *   - whether the remedy text may still be edited,
 *   - whether the due date may still be moved.
 *
 * Had those kept using `isTerminal`, making COMPLETED non-terminal would have
 * quietly re-opened completed work for editing and made it read as OVERDUE
 * again — regressing BE-21I without touching a line of its code.
 */
export const SETTLED_CORRECTIVE_ACTION_STATUSES: readonly CorrectiveActionStatus[] =
  ['COMPLETED', 'VERIFIED', 'REJECTED', 'CANCELLED'];

export function isSettledCorrectiveActionStatus(
  status: CorrectiveActionStatus,
): boolean {
  return SETTLED_CORRECTIVE_ACTION_STATUSES.includes(status);
}

/**
 * Backend-authoritative actions, computed per request from state × permission
 * × the Incident lifecycle. Never persisted, never recomputed by the client.
 */
export const CORRECTIVE_ACTION_ACTIONS = [
  'APPROVE',
  'REJECT',
  'START_PROGRESS',
  'COMPLETE',
  'CANCEL',
  'UPDATE_DETAILS',
  // BE-21I. Separate from UPDATE_DETAILS so a caller can be allowed to move a
  // deadline without being allowed to rewrite the remedy itself.
  'SET_DUE_DATE',
  // BE-21J. Offered only while a verification is outstanding.
  'SUBMIT_VERIFICATION',
] as const;

export type CorrectiveActionAction =
  (typeof CORRECTIVE_ACTION_ACTIONS)[number];

/**
 * The single source of truth linking a legal transition to the action that
 * offers it. Derived rather than hand-listed, so a permitted transition can
 * never become undiscoverable and an advertised action can never be rejected
 * on execution — the drift that bit BE-21B.
 */
export const CORRECTIVE_ACTION_TRANSITION_ACTIONS: {
  readonly [From in CorrectiveActionStatus]: {
    readonly [To in CorrectiveActionStatus]?: CorrectiveActionAction;
  };
} = {
  PROPOSED: {
    APPROVED: 'APPROVE',
    REJECTED: 'REJECT',
    CANCELLED: 'CANCEL',
  },
  APPROVED: {
    IN_PROGRESS: 'START_PROGRESS',
    COMPLETED: 'COMPLETE',
    CANCELLED: 'CANCEL',
  },
  IN_PROGRESS: { COMPLETED: 'COMPLETE', CANCELLED: 'CANCEL' },
  // BE-21J. Both moves out of COMPLETED are verification outcomes, so the
  // single action offered is "submit a verification decision" rather than two
  // status verbs a caller could invoke without a recorded decision.
  COMPLETED: { VERIFIED: 'SUBMIT_VERIFICATION', IN_PROGRESS: 'SUBMIT_VERIFICATION' },
  VERIFIED: {},
  REJECTED: {},
  CANCELLED: {},
};

/** Status-driven actions (permission and lifecycle gating happen upstream). */
export function correctiveActionTransitionActions(
  from: CorrectiveActionStatus,
): CorrectiveActionAction[] {
  return CORRECTIVE_ACTION_TRANSITIONS[from].map((to) => {
    const action = CORRECTIVE_ACTION_TRANSITION_ACTIONS[from][to];
    if (!action) {
      throw new Error(
        `Corrective Action transition ${from} → ${to} has no action mapping`,
      );
    }
    return action;
  });
}

/**
 * BE-21I — the statuses at which a deadline is still meaningful.
 *
 * These are exactly the statuses where work is still in flight, so it can
 * still run late. Derived rather than hand-listed, so extending the lifecycle
 * cannot leave this list silently stale — the drift that bit BE-21B.
 */
export const OPEN_CORRECTIVE_ACTION_STATUSES = CORRECTIVE_ACTION_STATUSES
  .filter((status) => !isSettledCorrectiveActionStatus(status));

/**
 * BE-21I — the derived deadline state. NEVER persisted.
 *
 *   NONE     — no due date has been set.
 *   ON_TRACK — open, with the deadline still ahead.
 *   OVERDUE  — open, and the deadline has passed.
 *   MET      — finished on or before the deadline.
 *   MISSED   — finished after the deadline (historical fact, not a live alarm).
 *
 * MET/MISSED exist so that finishing late is not forgotten the moment the
 * work completes. A COMPLETED action is never OVERDUE — the work is done, so
 * nothing is outstanding — but flattening a late completion to MET would
 * erase the delivery record. That distinction is why this is a five-value
 * enum and not a boolean.
 */
export const CORRECTIVE_ACTION_DUE_STATES = [
  'NONE',
  'ON_TRACK',
  'OVERDUE',
  'MET',
  'MISSED',
] as const;

export type CorrectiveActionDueState =
  (typeof CORRECTIVE_ACTION_DUE_STATES)[number];

/** The deadline projection returned alongside every Corrective Action read. */
export type CorrectiveActionDueStatus = {
  dueDate: string | null;
  dueState: CorrectiveActionDueState;
  /** True only for the live OVERDUE state — convenience, still derived. */
  isOverdue: boolean;
  /**
   * Whole days until the deadline (negative = days late), relative to `now`
   * for open work and to `completedAt` for finished work. Null without a
   * deadline.
   */
  daysUntilDue: number | null;
};

const MS_PER_DAY = 86_400_000;

/**
 * THE derivation. One pure function, no clock of its own and no storage, so
 * the same inputs always produce the same answer and it can be unit-reasoned
 * about without a database.
 *
 * `now` is injected rather than read from `Date.now()` inside, which is what
 * makes "overdue by one second" and "not yet due" testable deterministically.
 *
 * Ordering of the branches is the specification:
 *   1. No deadline            → NONE.
 *   2. Finished (any terminal
 *      status)                → MET or MISSED, judged against when it
 *                                actually finished. Never OVERDUE: an action
 *                                that is COMPLETED, REJECTED, or CANCELLED
 *                                has nothing outstanding.
 *   3. Still open             → OVERDUE past the deadline, else ON_TRACK.
 *
 * A terminal action with no completion timestamp (REJECTED / CANCELLED) is
 * judged against the moment it left the lifecycle, so calling work off before
 * its deadline does not later read as MISSED.
 */
export function resolveCorrectiveActionDueStatus(input: {
  dueDate: Date | null;
  status: CorrectiveActionStatus;
  completedAt: Date | null;
  statusChangedAt: Date;
  now: Date;
}): CorrectiveActionDueStatus {
  const { dueDate, status, completedAt, statusChangedAt, now } = input;

  if (!dueDate) {
    return {
      dueDate: null,
      dueState: 'NONE',
      isOverdue: false,
      daysUntilDue: null,
    };
  }

  const iso = dueDate.toISOString();
  const days = (from: Date): number =>
    Math.ceil((dueDate.getTime() - from.getTime()) / MS_PER_DAY);

  if (isSettledCorrectiveActionStatus(status)) {
    // Settled work is judged against when it settled, not against the clock.
    // BE-21J: COMPLETED and VERIFIED are settled even though COMPLETED still
    // awaits a decision — finished work is never "running late".
    const settledAt = completedAt ?? statusChangedAt;
    return {
      dueDate: iso,
      dueState: settledAt.getTime() <= dueDate.getTime() ? 'MET' : 'MISSED',
      isOverdue: false,
      daysUntilDue: days(settledAt),
    };
  }

  const overdue = now.getTime() > dueDate.getTime();
  return {
    dueDate: iso,
    dueState: overdue ? 'OVERDUE' : 'ON_TRACK',
    isOverdue: overdue,
    daysUntilDue: days(now),
  };
}

/** The row exactly as persisted. */
export type CorrectiveActionRecord = {
  id: string;
  incidentId: string;
  actionType: CorrectiveActionType;
  description: string;
  status: CorrectiveActionStatus;
  proposedAt: Date;
  /** Who performed each transition — NOT an assignment (see BE-21H). */
  approvedAt: Date | null;
  approvedByUserId: string | null;
  rejectedAt: Date | null;
  rejectedByUserId: string | null;
  rejectionReason: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  /** BE-21J. The decision itself and its history live in `reviews`. */
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  statusChangedAt: Date;
  notes: string | null;
  /**
   * BE-21I. The deadline itself plus who last set it. There is NO stored
   * overdue flag — that is derived on read (see
   * `resolveCorrectiveActionDueStatus`).
   */
  dueDate: Date | null;
  dueDateSetAt: Date | null;
  dueDateSetByUserId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * The joined row: the action plus the BE-21A Incident context it RESOLVES
 * through the FK. Incident fields are read, never stored here.
 */
export type CorrectiveActionCompositeRecord = CorrectiveActionRecord & {
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  incidentStatus: IncidentStatus;
};

/** Safe public representation. */
export type PublicCorrectiveAction = {
  /** The Corrective Action's OWN id — a child, not a specialization. */
  id: string;
  incidentId: string;
  /** Resolved Incident context, projected read-only from BE-21A. */
  clientId: string;
  buildingId: string;
  incidentNumber: string;
  incidentType: IncidentType;
  incidentStatus: IncidentStatus;
  actionType: CorrectiveActionType;
  description: string;
  status: CorrectiveActionStatus;
  proposedAt: string;
  approvedAt: string | null;
  approvedByUserId: string | null;
  rejectedAt: string | null;
  rejectedByUserId: string | null;
  rejectionReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedByUserId: string | null;
  completionNotes: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  /** BE-21J: when the remedy was independently confirmed, and by whom. */
  verifiedAt: string | null;
  verifiedByUserId: string | null;
  statusChangedAt: string;
  notes: string | null;
  /** BE-21I: the deadline as stored, plus who last set it. */
  dueDate: string | null;
  dueDateSetAt: string | null;
  dueDateSetByUserId: string | null;
  /**
   * BE-21I: the DERIVED deadline state, computed per request. Never stored,
   * and — like `availableActions` — never recomputed by the frontend.
   */
  dueStatus: CorrectiveActionDueStatus;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  /** Backend-resolved; the frontend must not recompute these. */
  availableActions: CorrectiveActionAction[];
};

/**
 * Creation input.
 *
 * `clientId` / `buildingId` are absent by design: the Incident already knows
 * its context. `status` is absent — a new proposal always starts PROPOSED.
 * `responsibleUserId` and any due date are absent because BE-21H and BE-21I
 * own them.
 */
export type CreateCorrectiveActionInput = {
  incidentId: string;
  actionType: CorrectiveActionType;
  description: string;
  notes?: string | null;
};

export type NewCorrectiveAction = {
  incidentId: string;
  actionType: CorrectiveActionType;
  description: string;
  notes: string | null;
  createdByUserId: string;
};

/**
 * `incidentId` is absent by design (no re-parenting), and so is `status` —
 * every transition is an explicit operation carrying its own metadata.
 */
export type UpdateCorrectiveActionInput = {
  actionType?: CorrectiveActionType;
  description?: string;
  notes?: string | null;
};

/**
 * BE-21I — setting or clearing the deadline.
 *
 * `dueDate: null` CLEARS it, which is why this is an explicit input type
 * rather than an optional field on `UpdateCorrectiveActionInput`: absent and
 * null must mean different things ("leave alone" vs "remove"), and folding it
 * into the general update would make that distinction invisible.
 */
export type SetCorrectiveActionDueDateInput = {
  dueDate: Date | null;
  /** Optional note explaining why the deadline was set or moved. */
  reason?: string | null;
};

/** A rejection must say why; the reason is preserved on the row. */
export type RejectCorrectiveActionInput = {
  rejectionReason: string;
};

export type CompleteCorrectiveActionInput = {
  completionNotes?: string | null;
};

export type CorrectiveActionFilters = {
  incidentId?: string;
  buildingId?: string;
  actionType?: CorrectiveActionType;
  status?: CorrectiveActionStatus;
  incidentStatus?: IncidentStatus;
  incidentType?: IncidentType;
  /**
   * BE-21I. `overdue=true` is answered by comparing `due_date` to the
   * database clock in SQL — the same rule as the read-time derivation, not a
   * stored flag being read back.
   */
  overdue?: boolean;
  hasDueDate?: boolean;
  dueBefore?: Date;
  dueAfter?: Date;
};

import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { incidentNotFoundError, incidentRepository } from '../incidents';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import {
  correctiveActionDueDateNotAllowedError,
  correctiveActionIncidentNotActiveError,
  correctiveActionInvalidTransitionError,
  correctiveActionNotFoundError,
  correctiveActionUpdateNotAllowedError,
} from './corrective-action.errors';
import { correctiveActionRepository } from './corrective-action.repository';
import {
  canTransitionCorrectiveActionStatus,
  correctiveActionTransitionActions,
  isSettledCorrectiveActionStatus,
  isTerminalCorrectiveActionStatus,
  resolveCorrectiveActionDueStatus,
  type CompleteCorrectiveActionInput,
  type CorrectiveActionAction,
  type CorrectiveActionCompositeRecord,
  type CorrectiveActionFilters,
  type CorrectiveActionStatus,
  type CreateCorrectiveActionInput,
  type PublicCorrectiveAction,
  type RejectCorrectiveActionInput,
  type SetCorrectiveActionDueDateInput,
  type UpdateCorrectiveActionInput,
} from './corrective-action.types';

/**
 * BE-21G — Corrective Action service.
 *
 * The durable fix for a BE-21A Incident of any type:
 *   - The Incident is REFERENCED. Its Client / Building context is resolved
 *     through the FK and never copied, so a corrective action cannot disagree
 *     with its Incident about where it applies.
 *   - Building access is asserted against the INCIDENT's Building on every
 *     read and write, so isolation is inherited from BE-21A.
 *   - History is preserved in the shared append-only BE-07 log, plus
 *     transition metadata retained on the row.
 *
 * NOT in this PART: Responsible Person (BE-21H), Due Date (BE-21I),
 * Verification (BE-21J), Closure (BE-21K).
 */

/**
 * Loads the parent Incident and asserts the caller may act in its Building.
 *
 * Order matters and is pinned by tests: unknown Incident 404 → inaccessible
 * Building 403 — consistent with BE-21A/E/F.
 */
async function resolveIncident(incidentId: string, actorUserId: string) {
  const incident = await incidentRepository.findById(incidentId);
  if (!incident) throw incidentNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    incident.buildingId,
  );
  return incident;
}

/**
 * Backend-authoritative available actions: state × permission × the BE-21A
 * Incident lifecycle.
 *
 * A CANCELLED Incident freezes its corrective actions, and a terminal action
 * offers nothing — including `UPDATE_DETAILS`, because a completed or
 * rejected proposal is a decision on record and editing it would falsify what
 * was agreed.
 */
function resolveAvailableActions(
  record: CorrectiveActionCompositeRecord,
  permissions: Set<string>,
): CorrectiveActionAction[] {
  if (record.incidentStatus !== 'REPORTED') return [];
  if (!permissions.has('corrective_action.manage')) return [];
  if (isTerminalCorrectiveActionStatus(record.status)) return [];

  // BE-21J. A COMPLETED action is settled but not terminal: the only thing
  // left to do is verify it, so that is the only action offered. Editing the
  // remedy or moving its deadline are both closed at this point.
  if (isSettledCorrectiveActionStatus(record.status)) {
    return correctiveActionTransitionActions(record.status)
      .filter((action, index, all) => all.indexOf(action) === index);
  }

  return [
    'UPDATE_DETAILS',
    // BE-21I. Offered for exactly as long as a deadline is meaningful: while
    // the action is still open. The gate above already excluded terminal
    // states, which is the same rule `setCorrectiveActionDueDate` enforces —
    // so this action can never be advertised and then refused.
    'SET_DUE_DATE',
    ...correctiveActionTransitionActions(record.status),
  ];
}

/**
 * BE-21I: `now` is injected so a whole listing is judged against ONE instant.
 * Reading the clock per row would let two actions with the same deadline
 * disagree about being overdue within a single response.
 */
export function toPublicCorrectiveAction(
  record: CorrectiveActionCompositeRecord,
  availableActions: CorrectiveActionAction[],
  now: Date = new Date(),
): PublicCorrectiveAction {
  return {
    id: record.id,
    incidentId: record.incidentId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    incidentNumber: record.incidentNumber,
    incidentType: record.incidentType,
    incidentStatus: record.incidentStatus,
    actionType: record.actionType,
    description: record.description,
    status: record.status,
    proposedAt: record.proposedAt.toISOString(),
    approvedAt: record.approvedAt?.toISOString() ?? null,
    approvedByUserId: record.approvedByUserId,
    rejectedAt: record.rejectedAt?.toISOString() ?? null,
    rejectedByUserId: record.rejectedByUserId,
    rejectionReason: record.rejectionReason,
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
    completedByUserId: record.completedByUserId,
    completionNotes: record.completionNotes,
    cancelledAt: record.cancelledAt?.toISOString() ?? null,
    cancelledByUserId: record.cancelledByUserId,
    verifiedAt: record.verifiedAt?.toISOString() ?? null,
    verifiedByUserId: record.verifiedByUserId,
    statusChangedAt: record.statusChangedAt.toISOString(),
    notes: record.notes,
    dueDate: record.dueDate?.toISOString() ?? null,
    dueDateSetAt: record.dueDateSetAt?.toISOString() ?? null,
    dueDateSetByUserId: record.dueDateSetByUserId,
    // DERIVED on every read — never read back from a stored column.
    dueStatus: resolveCorrectiveActionDueStatus({
      dueDate: record.dueDate,
      status: record.status,
      completedAt: record.completedAt,
      statusChangedAt: record.statusChangedAt,
      now,
    }),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    availableActions,
  };
}

async function present(
  record: CorrectiveActionCompositeRecord,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return toPublicCorrectiveAction(
    record,
    resolveAvailableActions(record, permissions),
  );
}

/** Appends to the shared append-only history log. */
async function recordHistory(
  record: CorrectiveActionCompositeRecord,
  eventType: string,
  actorUserId: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    entityType: 'CORRECTIVE_ACTION',
    entityId: record.id,
    eventType,
    actorUserId,
    summary,
    metadata: { incidentId: record.incidentId, ...metadata },
  });
}

export async function createCorrectiveAction(
  input: CreateCorrectiveActionInput,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  const incident = await resolveIncident(input.incidentId, actorUserId);
  // A withdrawn Incident cannot accrue new remedial work.
  if (incident.status !== 'REPORTED') {
    throw correctiveActionIncidentNotActiveError();
  }

  const created = await correctiveActionRepository.create({
    incidentId: incident.id,
    actionType: input.actionType,
    description: input.description,
    notes: input.notes ?? null,
    createdByUserId: actorUserId,
  });

  const record = await correctiveActionRepository.findById(created.id);
  if (!record) throw correctiveActionNotFoundError();

  await recordHistory(
    record,
    'CORRECTIVE_ACTION_PROPOSED',
    actorUserId,
    `Corrective action ${record.actionType} proposed for Incident ${record.incidentNumber}`,
    { actionType: record.actionType, status: record.status },
  );
  return present(record, actorUserId);
}

export async function getCorrectiveAction(
  id: string,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  const record = await correctiveActionRepository.findById(id);
  if (!record) throw correctiveActionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return present(record, actorUserId);
}

export async function listCorrectiveActions(
  filters: CorrectiveActionFilters,
  actorUserId: string,
): Promise<PublicCorrectiveAction[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  // Filtering by Incident asserts access to THAT Incident's Building, so an
  // unauthorized caller gets 403 rather than a silently empty list.
  if (filters.incidentId) {
    await resolveIncident(filters.incidentId, actorUserId);
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await correctiveActionRepository.list(filters, buildingIds);
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  // ONE instant for the whole page, so two rows sharing a deadline can never
  // disagree about being overdue within a single response.
  const now = new Date();
  return records.map((record) =>
    toPublicCorrectiveAction(
      record,
      resolveAvailableActions(record, permissions),
      now,
    ),
  );
}

/**
 * Loads an action for mutation and applies the gates common to every write:
 * existence, Building access, and the parent Incident's lifecycle.
 */
async function resolveMutable(
  id: string,
  actorUserId: string,
): Promise<CorrectiveActionCompositeRecord> {
  const record = await correctiveActionRepository.findById(id);
  if (!record) throw correctiveActionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  if (record.incidentStatus !== 'REPORTED') {
    throw correctiveActionUpdateNotAllowedError(
      'A CANCELLED Incident freezes its corrective actions.',
    );
  }
  return record;
}

export async function updateCorrectiveAction(
  id: string,
  input: UpdateCorrectiveActionInput,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  const existing = await resolveMutable(id, actorUserId);
  // A completed, verified, rejected, or cancelled proposal is a decision on
  // record. BE-21J: "settled", not "terminal" — a COMPLETED action awaiting
  // verification must stay closed to edits too.
  if (isSettledCorrectiveActionStatus(existing.status)) {
    throw correctiveActionUpdateNotAllowedError(
      `A Corrective Action in state ${existing.status} can no longer be updated.`,
    );
  }

  await correctiveActionRepository.update(id, input);

  const updated = await correctiveActionRepository.findById(id);
  if (!updated) throw correctiveActionNotFoundError();

  await recordHistory(
    updated,
    'CORRECTIVE_ACTION_UPDATED',
    actorUserId,
    `Corrective action ${updated.actionType} updated`,
    { fields: Object.keys(input) },
  );
  return present(updated, actorUserId);
}

/**
 * BE-21I — set, move, or clear the deadline.
 *
 * Reuses `resolveMutable`, so the deadline inherits BE-21G's gates unchanged:
 * unknown action 404 → inaccessible Building 403 → CANCELLED Incident refused.
 * Isolation and RBAC are therefore the SAME rules as every other write on
 * this resource, not a parallel set that could drift.
 *
 * A deadline is refused on terminal work. Allowing it would silently rewrite
 * history: a COMPLETED action's MET/MISSED verdict is derived from its
 * deadline, so moving that deadline afterwards would change whether the work
 * is recorded as having been delivered on time.
 *
 * This is NOT a status transition — the lifecycle is untouched, which is
 * precisely why it does not go through `transition()`. Setting a deadline
 * never moves a PROPOSED action to APPROVED, and a passing deadline never
 * moves it anywhere either: OVERDUE is a derived view of an unchanged status,
 * not a state the row enters.
 */
export async function setCorrectiveActionDueDate(
  id: string,
  input: SetCorrectiveActionDueDateInput,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  const existing = await resolveMutable(id, actorUserId);

  if (isSettledCorrectiveActionStatus(existing.status)) {
    throw correctiveActionDueDateNotAllowedError(
      `A Corrective Action in state ${existing.status} has already finished; its due date can no longer be changed.`,
    );
  }

  const applied = await correctiveActionRepository.setDueDate(
    id,
    existing.status,
    { dueDate: input.dueDate, setByUserId: actorUserId },
  );
  if (!applied) {
    // Lost the race against a concurrent transition into a terminal state.
    throw correctiveActionDueDateNotAllowedError(
      'The Corrective Action changed state before the due date could be set.',
    );
  }

  const updated = await correctiveActionRepository.findById(id);
  if (!updated) throw correctiveActionNotFoundError();

  const cleared = input.dueDate === null;
  await recordHistory(
    updated,
    cleared ? 'CORRECTIVE_ACTION_DUE_DATE_CLEARED' : 'CORRECTIVE_ACTION_DUE_DATE_SET',
    actorUserId,
    cleared
      ? `Due date cleared for corrective action ${updated.actionType}`
      : `Due date set to ${input.dueDate?.toISOString()} for corrective action ${updated.actionType}`,
    {
      // The append-only log is the deadline's change history: previous and
      // new value on every move, so no bespoke history table is needed.
      previousDueDate: existing.dueDate?.toISOString() ?? null,
      dueDate: input.dueDate?.toISOString() ?? null,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  );
  return present(updated, actorUserId);
}

/**
 * BE-21I — read the deadline and its DERIVED state.
 *
 * A thin projection of the same record the full read returns, so the deadline
 * endpoint and the action endpoint can never report different verdicts.
 */
export async function getCorrectiveActionDueDate(
  id: string,
  actorUserId: string,
): Promise<{
  correctiveActionId: string;
  incidentId: string;
  status: CorrectiveActionStatus;
  dueDate: string | null;
  dueDateSetAt: string | null;
  dueDateSetByUserId: string | null;
  dueStatus: PublicCorrectiveAction['dueStatus'];
}> {
  const record = await correctiveActionRepository.findById(id);
  if (!record) throw correctiveActionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);

  const projected = toPublicCorrectiveAction(record, []);
  return {
    correctiveActionId: projected.id,
    incidentId: projected.incidentId,
    status: projected.status,
    dueDate: projected.dueDate,
    dueDateSetAt: projected.dueDateSetAt,
    dueDateSetByUserId: projected.dueDateSetByUserId,
    dueStatus: projected.dueStatus,
  };
}

/**
 * Shared transition driver.
 *
 * Every status change validates against the SAME transition table and then
 * issues a status-guarded UPDATE, so no operation can invent a path the table
 * does not allow, and a lost race is reported rather than silently ignored.
 */
async function transition(
  id: string,
  to: CorrectiveActionStatus,
  actorUserId: string,
  apply: (
    record: CorrectiveActionCompositeRecord,
  ) => Promise<boolean>,
  eventType: string,
  metadata: (record: CorrectiveActionCompositeRecord) => Record<string, unknown> = () => ({}),
): Promise<PublicCorrectiveAction> {
  const existing = await resolveMutable(id, actorUserId);
  if (!canTransitionCorrectiveActionStatus(existing.status, to)) {
    throw correctiveActionInvalidTransitionError(existing.status, to);
  }

  const moved = await apply(existing);
  if (!moved) {
    // Lost the race against a concurrent transition.
    throw correctiveActionInvalidTransitionError(existing.status, to);
  }

  const updated = await correctiveActionRepository.findById(id);
  if (!updated) throw correctiveActionNotFoundError();

  await recordHistory(
    updated,
    eventType,
    actorUserId,
    `Corrective action moved from ${existing.status} to ${to}`,
    {
      fromStatus: existing.status,
      toStatus: to,
      ...metadata(existing),
    },
  );
  return present(updated, actorUserId);
}

export async function approveCorrectiveAction(
  id: string,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  return transition(
    id,
    'APPROVED',
    actorUserId,
    (record) =>
      correctiveActionRepository.approve(id, record.status, actorUserId),
    'CORRECTIVE_ACTION_APPROVED',
    () => ({ approvedByUserId: actorUserId }),
  );
}

export async function rejectCorrectiveAction(
  id: string,
  input: RejectCorrectiveActionInput,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  return transition(
    id,
    'REJECTED',
    actorUserId,
    (record) =>
      correctiveActionRepository.reject(id, record.status, {
        rejectedByUserId: actorUserId,
        rejectionReason: input.rejectionReason,
      }),
    'CORRECTIVE_ACTION_REJECTED',
    () => ({
      rejectedByUserId: actorUserId,
      rejectionReason: input.rejectionReason,
    }),
  );
}

export async function startCorrectiveAction(
  id: string,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  return transition(
    id,
    'IN_PROGRESS',
    actorUserId,
    (record) => correctiveActionRepository.start(id, record.status),
    'CORRECTIVE_ACTION_STARTED',
  );
}

export async function completeCorrectiveAction(
  id: string,
  input: CompleteCorrectiveActionInput,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  return transition(
    id,
    'COMPLETED',
    actorUserId,
    (record) =>
      correctiveActionRepository.complete(id, record.status, {
        completedByUserId: actorUserId,
        completionNotes: input.completionNotes ?? null,
      }),
    'CORRECTIVE_ACTION_COMPLETED',
    () => ({ completedByUserId: actorUserId }),
  );
}

export async function cancelCorrectiveAction(
  id: string,
  actorUserId: string,
): Promise<PublicCorrectiveAction> {
  return transition(
    id,
    'CANCELLED',
    actorUserId,
    (record) =>
      correctiveActionRepository.cancel(id, record.status, actorUserId),
    'CORRECTIVE_ACTION_CANCELLED',
    () => ({ cancelledByUserId: actorUserId }),
  );
}

export const correctiveActionService = {
  approveCorrectiveAction,
  cancelCorrectiveAction,
  completeCorrectiveAction,
  createCorrectiveAction,
  getCorrectiveAction,
  getCorrectiveActionDueDate,
  listCorrectiveActions,
  rejectCorrectiveAction,
  setCorrectiveActionDueDate,
  startCorrectiveAction,
  toPublicCorrectiveAction,
  updateCorrectiveAction,
};

import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { incidentNotFoundError, incidentRepository } from '../incidents';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { userRepository } from '../users';
import {
  immediateActionAlreadyCompletedError,
  immediateActionIncidentNotActiveError,
  immediateActionInvalidTransitionError,
  immediateActionNotFoundError,
  immediateActionResponsibleInvalidError,
  immediateActionTakenAtInvalidError,
  immediateActionUpdateNotAllowedError,
} from './immediate-action.errors';
import { immediateActionRepository } from './immediate-action.repository';
import {
  canTransitionImmediateActionStatus,
  immediateActionTransitionActions,
  isTerminalImmediateActionStatus,
  type CompleteImmediateActionInput,
  type CreateImmediateActionInput,
  type ImmediateActionAction,
  type ImmediateActionCompositeRecord,
  type ImmediateActionFilters,
  type ImmediateActionStatus,
  type PublicImmediateAction,
  type UpdateImmediateActionInput,
} from './immediate-action.types';

/**
 * BE-21E — Immediate Action service.
 *
 * A lightweight containment record attached to a BE-21A Incident of any type:
 *   - The Incident is REFERENCED. Its Client / Building context is resolved
 *     through the FK and never copied, so an action cannot disagree with its
 *     Incident about where it happened.
 *   - Building access is asserted against the INCIDENT's Building on every
 *     read and write, so isolation is inherited from BE-21A rather than
 *     re-invented.
 *   - Action history is preserved in the shared append-only BE-07
 *     `operational_events` log, plus completion metadata retained on the row.
 *
 * This is NOT Investigation (BE-21F) or Corrective Action (BE-21G): there is
 * no root cause, no corrective plan, no verification, and no closure here.
 */

/** Containment may be recorded after the fact, but never pre-dated. */
function assertTakenAt(takenAt: Date): void {
  if (takenAt.getTime() > Date.now()) {
    throw immediateActionTakenAtInvalidError();
  }
}

/**
 * A named responsible user must be a real, ACTIVE user who can access the
 * Building. Without this, containment could be attributed to an arbitrary or
 * deactivated account, or used to probe which user ids exist.
 */
async function assertResponsibleUser(
  responsibleUserId: string | null | undefined,
  buildingId: string,
): Promise<void> {
  if (!responsibleUserId) return;
  const user = await userRepository.findById(responsibleUserId);
  if (!user || user.status !== 'ACTIVE') {
    throw immediateActionResponsibleInvalidError();
  }
  if (!(await contextAccessService.canAccessBuilding(user.id, buildingId))) {
    throw immediateActionResponsibleInvalidError();
  }
}

/**
 * Loads the parent Incident and asserts the caller may act in its Building.
 *
 * Order matters and is pinned by tests: unknown Incident 404 → inaccessible
 * Building 403. Access is asserted before any Incident detail is used, so an
 * out-of-scope Incident is never confirmed to exist beyond its id.
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
 * A CANCELLED Incident freezes its actions, and a terminal action offers
 * nothing — including `UPDATE_DETAILS`, because a completed containment record
 * is history and editing it would falsify the timeline.
 */
function resolveAvailableActions(
  record: ImmediateActionCompositeRecord,
  permissions: Set<string>,
): ImmediateActionAction[] {
  if (record.incidentStatus !== 'REPORTED') return [];
  if (!permissions.has('immediate_action.manage')) return [];
  if (isTerminalImmediateActionStatus(record.status)) return [];

  return [
    'UPDATE_DETAILS',
    ...immediateActionTransitionActions(record.status),
  ];
}

export function toPublicImmediateAction(
  record: ImmediateActionCompositeRecord,
  availableActions: ImmediateActionAction[],
): PublicImmediateAction {
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
    takenAt: record.takenAt.toISOString(),
    responsibleUserId: record.responsibleUserId,
    completedAt: record.completedAt?.toISOString() ?? null,
    completedByUserId: record.completedByUserId,
    completionNotes: record.completionNotes,
    statusChangedAt: record.statusChangedAt.toISOString(),
    notes: record.notes,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    availableActions,
  };
}

async function present(
  record: ImmediateActionCompositeRecord,
  actorUserId: string,
): Promise<PublicImmediateAction> {
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return toPublicImmediateAction(
    record,
    resolveAvailableActions(record, permissions),
  );
}

/** Appends to the shared append-only history log. */
async function recordHistory(
  record: ImmediateActionCompositeRecord,
  eventType: string,
  actorUserId: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    entityType: 'IMMEDIATE_ACTION',
    entityId: record.id,
    eventType,
    actorUserId,
    summary,
    metadata: { incidentId: record.incidentId, ...metadata },
  });
}

export async function createImmediateAction(
  input: CreateImmediateActionInput,
  actorUserId: string,
): Promise<PublicImmediateAction> {
  const incident = await resolveIncident(input.incidentId, actorUserId);
  // A withdrawn Incident cannot accrue new response records.
  if (incident.status !== 'REPORTED') {
    throw immediateActionIncidentNotActiveError();
  }
  assertTakenAt(input.takenAt);
  await assertResponsibleUser(input.responsibleUserId, incident.buildingId);

  const created = await immediateActionRepository.create({
    incidentId: incident.id,
    actionType: input.actionType,
    description: input.description,
    takenAt: input.takenAt,
    responsibleUserId: input.responsibleUserId ?? null,
    notes: input.notes ?? null,
    createdByUserId: actorUserId,
  });

  const record = await immediateActionRepository.findById(created.id);
  if (!record) throw immediateActionNotFoundError();

  await recordHistory(
    record,
    'IMMEDIATE_ACTION_RECORDED',
    actorUserId,
    `Immediate action ${record.actionType} recorded for Incident ${record.incidentNumber}`,
    {
      actionType: record.actionType,
      status: record.status,
      takenAt: record.takenAt.toISOString(),
      responsibleUserId: record.responsibleUserId,
    },
  );
  return present(record, actorUserId);
}

export async function getImmediateAction(
  id: string,
  actorUserId: string,
): Promise<PublicImmediateAction> {
  const record = await immediateActionRepository.findById(id);
  if (!record) throw immediateActionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return present(record, actorUserId);
}

export async function listImmediateActions(
  filters: ImmediateActionFilters,
  actorUserId: string,
): Promise<PublicImmediateAction[]> {
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
  const records = await immediateActionRepository.list(filters, buildingIds);
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return records.map((record) =>
    toPublicImmediateAction(record, resolveAvailableActions(record, permissions)),
  );
}

/**
 * Loads an action for mutation and applies the gates common to every write:
 * existence, Building access, the parent Incident's lifecycle, and this
 * action's own terminality.
 */
async function resolveMutable(
  id: string,
  actorUserId: string,
): Promise<ImmediateActionCompositeRecord> {
  const record = await immediateActionRepository.findById(id);
  if (!record) throw immediateActionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  if (record.incidentStatus !== 'REPORTED') {
    throw immediateActionUpdateNotAllowedError(
      'A CANCELLED Incident freezes its immediate actions.',
    );
  }
  return record;
}

export async function updateImmediateAction(
  id: string,
  input: UpdateImmediateActionInput,
  actorUserId: string,
): Promise<PublicImmediateAction> {
  const existing = await resolveMutable(id, actorUserId);
  // A completed or cancelled containment record is history, not a draft.
  if (isTerminalImmediateActionStatus(existing.status)) {
    throw immediateActionUpdateNotAllowedError(
      `An Immediate Action in state ${existing.status} can no longer be updated.`,
    );
  }
  if (input.takenAt !== undefined) assertTakenAt(input.takenAt);
  if (input.responsibleUserId !== undefined) {
    await assertResponsibleUser(input.responsibleUserId, existing.buildingId);
  }

  await immediateActionRepository.update(id, input);

  const updated = await immediateActionRepository.findById(id);
  if (!updated) throw immediateActionNotFoundError();

  await recordHistory(
    updated,
    'IMMEDIATE_ACTION_UPDATED',
    actorUserId,
    `Immediate action ${updated.actionType} updated`,
    { fields: Object.keys(input) },
  );
  return present(updated, actorUserId);
}

/**
 * Moves an action to a non-completion status (IN_PROGRESS / CANCELLED).
 * Completion has its own operation because it carries metadata.
 */
export async function transitionImmediateAction(
  id: string,
  to: Exclude<ImmediateActionStatus, 'COMPLETED'>,
  actorUserId: string,
): Promise<PublicImmediateAction> {
  const existing = await resolveMutable(id, actorUserId);
  if (!canTransitionImmediateActionStatus(existing.status, to)) {
    throw immediateActionInvalidTransitionError(existing.status, to);
  }

  const moved = await immediateActionRepository.transitionStatus(
    id,
    existing.status,
    to,
  );
  if (!moved) {
    throw immediateActionInvalidTransitionError(existing.status, to);
  }

  const updated = await immediateActionRepository.findById(id);
  if (!updated) throw immediateActionNotFoundError();

  await recordHistory(
    updated,
    'IMMEDIATE_ACTION_STATUS_CHANGED',
    actorUserId,
    `Immediate action moved from ${existing.status} to ${to}`,
    { fromStatus: existing.status, toStatus: to },
  );
  return present(updated, actorUserId);
}

/**
 * Marks an action completed, preserving who completed it and when.
 *
 * `completedAt` may be supplied (containment is often recorded after the
 * fact) but never pre-dated, and never earlier than `takenAt` — a containment
 * cannot finish before it started.
 */
export async function completeImmediateAction(
  id: string,
  input: CompleteImmediateActionInput,
  actorUserId: string,
): Promise<PublicImmediateAction> {
  const existing = await resolveMutable(id, actorUserId);
  if (existing.status === 'COMPLETED') {
    throw immediateActionAlreadyCompletedError();
  }
  if (!canTransitionImmediateActionStatus(existing.status, 'COMPLETED')) {
    throw immediateActionInvalidTransitionError(existing.status, 'COMPLETED');
  }

  const completedAt = input.completedAt ?? new Date();
  assertTakenAt(completedAt);
  if (completedAt.getTime() < existing.takenAt.getTime()) {
    throw immediateActionTakenAtInvalidError();
  }

  const completed = await immediateActionRepository.complete(
    id,
    existing.status,
    {
      completedAt,
      completedByUserId: actorUserId,
      completionNotes: input.completionNotes ?? null,
    },
  );
  if (!completed) {
    // Lost the race against a concurrent transition.
    throw immediateActionAlreadyCompletedError();
  }

  const updated = await immediateActionRepository.findById(id);
  if (!updated) throw immediateActionNotFoundError();

  await recordHistory(
    updated,
    'IMMEDIATE_ACTION_COMPLETED',
    actorUserId,
    `Immediate action ${updated.actionType} completed`,
    {
      fromStatus: existing.status,
      completedAt: completedAt.toISOString(),
      completedByUserId: actorUserId,
    },
  );
  return present(updated, actorUserId);
}

export const immediateActionService = {
  completeImmediateAction,
  createImmediateAction,
  getImmediateAction,
  listImmediateActions,
  toPublicImmediateAction,
  transitionImmediateAction,
  updateImmediateAction,
};

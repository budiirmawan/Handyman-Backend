import { withTransaction } from '../../database';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import {
  correctiveActionNotFoundError,
  correctiveActionRepository,
  type CorrectiveActionCompositeRecord,
} from '../corrective-actions';
import { organizationRepository } from '../organizations';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { workforceRepository } from '../workforce';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import {
  correctiveActionResponsibilityAlreadyAssignedError,
  correctiveActionResponsibilityNotAllowedError,
  correctiveActionResponsibilityNotFoundError,
  correctiveActionResponsiblePersonBuildingMismatchError,
  correctiveActionResponsiblePersonClientMismatchError,
  correctiveActionResponsiblePersonInvalidError,
} from './corrective-action-responsibility.errors';
import { correctiveActionResponsibilityRepository } from './corrective-action-responsibility.repository';
import {
  isAssignableCorrectiveActionStatus,
  type AssignResponsiblePersonInput,
  type CorrectiveActionResponsibilityCompositeRecord,
  type CorrectiveActionResponsibilityFilters,
  type PublicCorrectiveActionResponsibility,
  type ReleaseResponsiblePersonInput,
  type ResponsibilityAction,
  type UpdateResponsiblePersonInput,
} from './corrective-action-responsibility.types';

/**
 * BE-21H — Responsible Person service.
 *
 * Names WHO is accountable for a BE-21G Corrective Action by REFERENCE to an
 * existing BE-03C Workforce Profile:
 *   - No person data is duplicated. `workforceProfileId` is the only identity
 *     stored; names and org placement are projected fresh on every read.
 *   - The person must belong to the same Client as the Incident AND hold an
 *     effective placement at its Building.
 *   - Reassignment supersedes rather than overwrites, so the chain of
 *     accountability survives.
 *
 * NOT in this PART: Due Date (BE-21I), Verification (BE-21J), Closure
 * (BE-21K).
 */

/**
 * Loads the Corrective Action and asserts the caller may act in its Building.
 *
 * Order matters and is pinned by tests: unknown action 404 → inaccessible
 * Building 403 — consistent with BE-21A/E/F/G.
 */
async function resolveCorrectiveAction(
  correctiveActionId: string,
  actorUserId: string,
): Promise<CorrectiveActionCompositeRecord> {
  const action = await correctiveActionRepository.findById(correctiveActionId);
  if (!action) throw correctiveActionNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, action.buildingId);
  return action;
}

/**
 * Validates that the referenced person may hold this responsibility.
 *
 * Three separate checks, in widening order of specificity:
 *   1. The profile exists and is ACTIVE — accountability cannot rest with a
 *      departed or unknown person.
 *   2. Its Client matches the Incident's. A Workforce Profile belongs to an
 *      Organization, which belongs to a Client; assigning across that
 *      boundary would leak one Client's personnel into another's incident
 *      record.
 *   3. It holds an EFFECTIVE placement at the Incident's Building, reusing
 *      BE-03C's own placement rules (active, in date range, active Building)
 *      rather than re-deriving them here.
 *
 * Existence and inactivity share one error code so this endpoint cannot be
 * used to enumerate profile ids.
 */
async function assertAssignablePerson(
  workforceProfileId: string,
  incidentClientId: string,
  incidentBuildingId: string,
): Promise<void> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile || profile.status !== 'ACTIVE') {
    throw correctiveActionResponsiblePersonInvalidError();
  }

  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    // The FK guarantees an organization exists, so this is a data-integrity
    // fault rather than a caller error — reported as an unusable reference.
    throw correctiveActionResponsiblePersonInvalidError();
  }
  if (organization.clientId !== incidentClientId) {
    throw correctiveActionResponsiblePersonClientMismatchError();
  }

  const placements =
    await workforceBuildingAssignmentRepository.listEffectiveByWorkforceProfileId(
      workforceProfileId,
      new Date(),
    );
  if (!placements.some((placement) => placement.building.id === incidentBuildingId)) {
    throw correctiveActionResponsiblePersonBuildingMismatchError();
  }
}

/**
 * Responsibility may only change while the work is still live. Assigning
 * accountability for refused, finished, or cancelled work is meaningless, and
 * a CANCELLED Incident freezes everything beneath it.
 */
function assertAssignable(action: CorrectiveActionCompositeRecord): void {
  if (action.incidentStatus !== 'REPORTED') {
    throw correctiveActionResponsibilityNotAllowedError(
      'A CANCELLED Incident freezes responsibility for its corrective actions.',
    );
  }
  if (!isAssignableCorrectiveActionStatus(action.status)) {
    throw correctiveActionResponsibilityNotAllowedError(
      `A Corrective Action in state ${action.status} cannot change responsible person.`,
    );
  }
}

/**
 * Backend-authoritative available actions: assignment state × permission ×
 * the lifecycles above. A superseded assignment offers nothing — it is
 * history.
 */
function resolveAvailableActions(
  record: CorrectiveActionResponsibilityCompositeRecord,
  permissions: Set<string>,
): ResponsibilityAction[] {
  if (record.status !== 'ACTIVE') return [];
  if (record.incidentStatus !== 'REPORTED') return [];
  if (!permissions.has('corrective_action_responsibility.manage')) return [];
  if (!isAssignableCorrectiveActionStatus(record.correctiveActionStatus)) {
    return [];
  }
  return ['REASSIGN', 'UPDATE_NOTE', 'RELEASE'];
}

export function toPublicResponsibility(
  record: CorrectiveActionResponsibilityCompositeRecord,
  availableActions: ResponsibilityAction[],
): PublicCorrectiveActionResponsibility {
  return {
    id: record.id,
    correctiveActionId: record.correctiveActionId,
    incidentId: record.incidentId,
    clientId: record.clientId,
    buildingId: record.buildingId,
    incidentNumber: record.incidentNumber,
    incidentType: record.incidentType,
    incidentStatus: record.incidentStatus,
    correctiveActionStatus: record.correctiveActionStatus,
    // Projected from BE-03C on every read — a view, never a stored copy.
    responsiblePerson: {
      workforceProfileId: record.workforceProfileId,
      fullName: record.workforceFullName,
      employeeCode: record.workforceEmployeeCode,
      status: record.workforceStatus,
      workforceType: record.workforceType,
      organizationId: record.workforceOrganizationId,
      departmentId: record.workforceDepartmentId,
      teamId: record.workforceTeamId,
      userId: record.workforceUserId,
    },
    responsibilityNote: record.responsibilityNote,
    status: record.status,
    assignedByUserId: record.assignedByUserId,
    assignedAt: record.assignedAt.toISOString(),
    releasedAt: record.releasedAt?.toISOString() ?? null,
    releasedByUserId: record.releasedByUserId,
    releaseReason: record.releaseReason,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    availableActions,
  };
}

async function present(
  record: CorrectiveActionResponsibilityCompositeRecord,
  actorUserId: string,
): Promise<PublicCorrectiveActionResponsibility> {
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return toPublicResponsibility(
    record,
    resolveAvailableActions(record, permissions),
  );
}

/** Appends to the shared append-only history log. */
async function recordHistory(
  record: CorrectiveActionResponsibilityCompositeRecord,
  eventType: string,
  actorUserId: string,
  summary: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await recordOperationalEvent({
    clientId: record.clientId,
    buildingId: record.buildingId,
    entityType: 'CORRECTIVE_ACTION_RESPONSIBILITY',
    entityId: record.id,
    eventType,
    actorUserId,
    summary,
    metadata: {
      correctiveActionId: record.correctiveActionId,
      incidentId: record.incidentId,
      workforceProfileId: record.workforceProfileId,
      ...metadata,
    },
  });
}

export async function assignResponsiblePerson(
  correctiveActionId: string,
  input: AssignResponsiblePersonInput,
  actorUserId: string,
): Promise<PublicCorrectiveActionResponsibility> {
  const action = await resolveCorrectiveAction(correctiveActionId, actorUserId);
  assertAssignable(action);
  await assertAssignablePerson(
    input.workforceProfileId,
    action.clientId,
    action.buildingId,
  );

  // Assignment is create-only. Replacing an existing responsible person is a
  // REASSIGNMENT (PATCH) so the supersession is explicit and auditable.
  const existing =
    await correctiveActionResponsibilityRepository.findActiveByCorrectiveActionId(
      correctiveActionId,
    );
  if (existing) throw correctiveActionResponsibilityAlreadyAssignedError();

  const created = await correctiveActionResponsibilityRepository.create({
    correctiveActionId,
    workforceProfileId: input.workforceProfileId,
    responsibilityNote: input.responsibilityNote ?? null,
    assignedByUserId: actorUserId,
  });

  const record = await correctiveActionResponsibilityRepository.findById(
    created.id,
  );
  if (!record) throw correctiveActionResponsibilityNotFoundError();

  await recordHistory(
    record,
    'CORRECTIVE_ACTION_RESPONSIBILITY_ASSIGNED',
    actorUserId,
    `Responsible person assigned to corrective action ${record.correctiveActionId}`,
    { assignedByUserId: actorUserId },
  );
  return present(record, actorUserId);
}

/** The CURRENT responsible person, or 404 when none is assigned. */
export async function getResponsiblePerson(
  correctiveActionId: string,
  actorUserId: string,
): Promise<PublicCorrectiveActionResponsibility> {
  await resolveCorrectiveAction(correctiveActionId, actorUserId);
  const record =
    await correctiveActionResponsibilityRepository.findActiveByCorrectiveActionId(
      correctiveActionId,
    );
  if (!record) throw correctiveActionResponsibilityNotFoundError();
  return present(record, actorUserId);
}

/** The full accountability chain, current and superseded. */
export async function listResponsibilityHistory(
  correctiveActionId: string,
  actorUserId: string,
): Promise<PublicCorrectiveActionResponsibility[]> {
  await resolveCorrectiveAction(correctiveActionId, actorUserId);
  const records =
    await correctiveActionResponsibilityRepository.listByCorrectiveActionId(
      correctiveActionId,
    );
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return records.map((record) =>
    toPublicResponsibility(record, resolveAvailableActions(record, permissions)),
  );
}

export async function listResponsibilities(
  filters: CorrectiveActionResponsibilityFilters,
  actorUserId: string,
): Promise<PublicCorrectiveActionResponsibility[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  if (filters.correctiveActionId) {
    await resolveCorrectiveAction(filters.correctiveActionId, actorUserId);
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await correctiveActionResponsibilityRepository.list(
    filters,
    buildingIds,
  );
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return records.map((record) =>
    toPublicResponsibility(record, resolveAvailableActions(record, permissions)),
  );
}

/**
 * Updates the assignment: either edits the note, or REASSIGNS to a different
 * person.
 *
 * Reassignment never mutates the person on an existing row. It deactivates
 * the current assignment and inserts a new ACTIVE one inside a single
 * transaction, so the chain of accountability is preserved and the partial
 * unique index is never transiently violated. The row is locked FOR UPDATE
 * first, so two concurrent reassignments serialize rather than colliding on
 * that index.
 */
export async function updateResponsiblePerson(
  correctiveActionId: string,
  input: UpdateResponsiblePersonInput,
  actorUserId: string,
): Promise<PublicCorrectiveActionResponsibility> {
  const action = await resolveCorrectiveAction(correctiveActionId, actorUserId);
  assertAssignable(action);

  const current =
    await correctiveActionResponsibilityRepository.findActiveByCorrectiveActionId(
      correctiveActionId,
    );
  if (!current) throw correctiveActionResponsibilityNotFoundError();

  const isReassignment =
    input.workforceProfileId !== undefined &&
    input.workforceProfileId !== current.workforceProfileId;

  if (!isReassignment) {
    // Same person (or unspecified): only the note changes.
    if (input.responsibilityNote === undefined) {
      return present(current, actorUserId);
    }
    await correctiveActionResponsibilityRepository.updateNote(
      current.id,
      input.responsibilityNote,
    );
    const updated = await correctiveActionResponsibilityRepository.findById(
      current.id,
    );
    if (!updated) throw correctiveActionResponsibilityNotFoundError();

    await recordHistory(
      updated,
      'CORRECTIVE_ACTION_RESPONSIBILITY_NOTE_UPDATED',
      actorUserId,
      'Responsibility note updated',
      {},
    );
    return present(updated, actorUserId);
  }

  const nextWorkforceProfileId = input.workforceProfileId as string;
  await assertAssignablePerson(
    nextWorkforceProfileId,
    action.clientId,
    action.buildingId,
  );

  const createdId = await withTransaction(async (client) => {
    const locked =
      await correctiveActionResponsibilityRepository.lockActiveByCorrectiveActionId(
        correctiveActionId,
        client,
      );
    // Another reassignment won the race and this one's premise is stale.
    if (!locked) throw correctiveActionResponsibilityNotFoundError();

    const released = await correctiveActionResponsibilityRepository.deactivate(
      locked.id,
      {
        releasedByUserId: actorUserId,
        releaseReason: input.releaseReason ?? 'Reassigned',
      },
      client,
    );
    if (!released) throw correctiveActionResponsibilityNotFoundError();

    const created = await correctiveActionResponsibilityRepository.create(
      {
        correctiveActionId,
        workforceProfileId: nextWorkforceProfileId,
        responsibilityNote: input.responsibilityNote ?? null,
        assignedByUserId: actorUserId,
      },
      client,
    );
    return created.id;
  });

  const record = await correctiveActionResponsibilityRepository.findById(
    createdId,
  );
  if (!record) throw correctiveActionResponsibilityNotFoundError();

  await recordHistory(
    record,
    'CORRECTIVE_ACTION_RESPONSIBILITY_REASSIGNED',
    actorUserId,
    'Responsible person reassigned',
    {
      previousWorkforceProfileId: current.workforceProfileId,
      previousResponsibilityId: current.id,
    },
  );
  return present(record, actorUserId);
}

/** Releases the current responsible person, leaving the action unassigned. */
export async function releaseResponsiblePerson(
  correctiveActionId: string,
  input: ReleaseResponsiblePersonInput,
  actorUserId: string,
): Promise<PublicCorrectiveActionResponsibility> {
  const action = await resolveCorrectiveAction(correctiveActionId, actorUserId);
  assertAssignable(action);

  const current =
    await correctiveActionResponsibilityRepository.findActiveByCorrectiveActionId(
      correctiveActionId,
    );
  if (!current) throw correctiveActionResponsibilityNotFoundError();

  const released = await correctiveActionResponsibilityRepository.deactivate(
    current.id,
    {
      releasedByUserId: actorUserId,
      releaseReason: input.releaseReason ?? null,
    },
  );
  // Lost the race against a concurrent release or reassignment.
  if (!released) throw correctiveActionResponsibilityNotFoundError();

  const record = await correctiveActionResponsibilityRepository.findById(
    current.id,
  );
  if (!record) throw correctiveActionResponsibilityNotFoundError();

  await recordHistory(
    record,
    'CORRECTIVE_ACTION_RESPONSIBILITY_RELEASED',
    actorUserId,
    'Responsible person released',
    { releasedByUserId: actorUserId },
  );
  return present(record, actorUserId);
}

export const correctiveActionResponsibilityService = {
  assignResponsiblePerson,
  getResponsiblePerson,
  listResponsibilities,
  listResponsibilityHistory,
  releaseResponsiblePerson,
  toPublicResponsibility,
  updateResponsiblePerson,
};

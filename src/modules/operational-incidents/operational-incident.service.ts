import { withTransaction } from '../../database';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import {
  incidentRepository,
  isIncidentNumberUniqueViolation,
  incidentNumberAlreadyExistsError,
  resolveBuildingContext,
  resolveLocation,
} from '../incidents';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import { userRepository } from '../users';
import {
  operationalIncidentInvalidTransitionError,
  operationalIncidentNotFoundError,
  operationalIncidentOccurrenceInvalidError,
  operationalIncidentReporterInvalidError,
  operationalIncidentTypeMismatchError,
  operationalIncidentUpdateNotAllowedError,
} from './operational-incident.errors';
import { operationalIncidentRepository } from './operational-incident.repository';
import {
  canTransitionOperationalIncidentStatus,
  operationalIncidentTransitionActions,
  type CreateOperationalIncidentInput,
  type OperationalIncidentAction,
  type OperationalIncidentCompositeRecord,
  type OperationalIncidentFilters,
  type PublicOperationalIncident,
  type UpdateOperationalIncidentInput,
} from './operational-incident.types';

/**
 * BE-21B — Operational Incident service.
 *
 * An Operational Incident is a SPECIALIZATION of the BE-21A foundation, not a
 * parallel domain:
 *   - The Incident row is created through BE-21A's repository with
 *     `incidentType` pinned to OPERATIONAL — the caller cannot choose it.
 *   - Client derivation, Building access, and BE-04 location validation reuse
 *     BE-21A's exported authorities rather than re-implementing them.
 *   - Identity (`incidentNumber`), context, and the record lifecycle stay on
 *     `incidents`; only category, occurrence, operational status, and notes
 *     live in the specialization.
 *   - Foundation + specialization are written in ONE transaction, so a
 *     half-built Operational Incident can never exist.
 *
 * Status and `availableActions` are resolved by the backend on every read.
 * BE-09 remains authoritative for Finding workflow — nothing here reads or
 * writes Finding state, and this small closed transition table is deliberately
 * not a generic workflow engine.
 */

/** Occurrence may be backdated but never post-dated. */
function assertOccurrence(occurredAt: Date): void {
  if (occurredAt.getTime() > Date.now()) {
    throw operationalIncidentOccurrenceInvalidError();
  }
}

/**
 * A reporter other than the actor must be a real, ACTIVE user who can access
 * the Building. Without this, an incident could be attributed to an arbitrary
 * or deactivated account, or used to probe which user ids exist.
 */
async function resolveReporter(
  reportedByUserId: string | undefined,
  actorUserId: string,
  buildingId: string,
): Promise<string> {
  if (!reportedByUserId || reportedByUserId === actorUserId) {
    return actorUserId;
  }
  const reporter = await userRepository.findById(reportedByUserId);
  if (!reporter || reporter.status !== 'ACTIVE') {
    throw operationalIncidentReporterInvalidError();
  }
  if (!(await contextAccessService.canAccessBuilding(reporter.id, buildingId))) {
    throw operationalIncidentReporterInvalidError();
  }
  return reporter.id;
}

function resolveLocationId(
  record: OperationalIncidentCompositeRecord,
): string | null {
  switch (record.locationType) {
    case 'FLOOR':
      return record.floorId;
    case 'AREA':
      return record.areaId;
    case 'ROOM':
      return record.roomId;
    case 'SPACE':
      return record.spaceId;
    case 'FUNCTIONAL_LOCATION':
      return record.functionalLocationId;
    default:
      return null;
  }
}

/**
 * Backend-authoritative available actions: state × permission × the BE-21A
 * record lifecycle. A CANCELLED Incident yields no actions at all, so the
 * foundation stays authoritative over the specialization.
 */
function resolveAvailableActions(
  record: OperationalIncidentCompositeRecord,
  permissions: Set<string>,
): OperationalIncidentAction[] {
  if (record.incidentStatus !== 'REPORTED') return [];
  if (!permissions.has('operational_incident.manage')) return [];

  return [
    'UPDATE_DETAILS',
    ...operationalIncidentTransitionActions(record.operationalStatus),
  ];
}

export function toPublicOperationalIncident(
  record: OperationalIncidentCompositeRecord,
  availableActions: OperationalIncidentAction[],
): PublicOperationalIncident {
  return {
    id: record.incidentId,
    operationalIncidentId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    incidentNumber: record.incidentNumber,
    incidentType: 'OPERATIONAL',
    title: record.title,
    description: record.description,
    severity: record.severity,
    priority: record.priority,
    incidentStatus: record.incidentStatus,
    operationalStatus: record.operationalStatus,
    operationalCategory: record.operationalCategory,
    occurredAt: record.occurredAt.toISOString(),
    statusChangedAt: record.statusChangedAt.toISOString(),
    notes: record.notes,
    locationType: record.locationType,
    locationId: resolveLocationId(record),
    floorId: record.floorId,
    areaId: record.areaId,
    roomId: record.roomId,
    spaceId: record.spaceId,
    functionalLocationId: record.functionalLocationId,
    reportedByUserId: record.reportedByUserId,
    reportedAt: record.reportedAt.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    availableActions,
  };
}

async function present(
  record: OperationalIncidentCompositeRecord,
  actorUserId: string,
): Promise<PublicOperationalIncident> {
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return toPublicOperationalIncident(
    record,
    resolveAvailableActions(record, permissions),
  );
}

export async function createOperationalIncident(
  input: CreateOperationalIncidentInput,
  actorUserId: string,
): Promise<PublicOperationalIncident> {
  // Reuses BE-21A's Client derivation + Building access assertion verbatim.
  const { clientId } = await resolveBuildingContext(
    input.buildingId,
    actorUserId,
  );
  const location = await resolveLocation(
    input.locationType,
    input.locationId,
    input.buildingId,
  );
  assertOccurrence(input.occurredAt);
  const reportedByUserId = await resolveReporter(
    input.reportedByUserId,
    actorUserId,
    input.buildingId,
  );

  const existing = await incidentRepository.findByClientAndNumber(
    clientId,
    input.incidentNumber,
  );
  if (existing) throw incidentNumberAlreadyExistsError();

  try {
    // Foundation + specialization are atomic: no orphan Incident on failure.
    const incidentId = await withTransaction(async (client) => {
      const incident = await incidentRepository.create(
        {
          clientId,
          buildingId: input.buildingId,
          incidentNumber: input.incidentNumber,
          // BE-21B always pins the discriminator; callers cannot set it.
          incidentType: 'OPERATIONAL',
          title: input.title,
          description: input.description ?? null,
          severity: input.severity ?? 'MEDIUM',
          priority: input.priority ?? 'MEDIUM',
          ...location,
          reportedByUserId,
          reportedAt: new Date(),
        },
        client,
      );
      await operationalIncidentRepository.create(
        {
          incidentId: incident.id,
          operationalCategory: input.operationalCategory,
          occurredAt: input.occurredAt,
          notes: input.notes ?? null,
          createdByUserId: actorUserId,
        },
        client,
      );
      return incident.id;
    });

    const created = await operationalIncidentRepository.findByIncidentId(
      incidentId,
    );
    if (!created) throw operationalIncidentNotFoundError();

    await recordOperationalEvent({
      clientId: created.clientId,
      buildingId: created.buildingId,
      entityType: 'INCIDENT',
      entityId: created.incidentId,
      eventType: 'OPERATIONAL_INCIDENT_REPORTED',
      actorUserId,
      summary: `Operational Incident ${created.incidentNumber} reported`,
      metadata: {
        incidentNumber: created.incidentNumber,
        operationalCategory: created.operationalCategory,
        severity: created.severity,
        priority: created.priority,
        occurredAt: created.occurredAt.toISOString(),
      },
    });
    return present(created, actorUserId);
  } catch (error) {
    if (isIncidentNumberUniqueViolation(error)) {
      throw incidentNumberAlreadyExistsError();
    }
    throw error;
  }
}

export async function getOperationalIncident(
  incidentId: string,
  actorUserId: string,
): Promise<PublicOperationalIncident> {
  const record = await operationalIncidentRepository.findByIncidentId(
    incidentId,
  );
  if (!record) throw operationalIncidentNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    record.buildingId,
  );
  return present(record, actorUserId);
}

export async function listOperationalIncidents(
  filters: OperationalIncidentFilters,
  actorUserId: string,
): Promise<PublicOperationalIncident[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await operationalIncidentRepository.list(
    filters,
    buildingIds,
  );
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return records.map((record) =>
    toPublicOperationalIncident(
      record,
      resolveAvailableActions(record, permissions),
    ),
  );
}

/**
 * Updates operational details and, where supplied, the foundation metadata —
 * atomically. The BE-21A lifecycle gates the whole operation: once the
 * Incident is CANCELLED nothing may change.
 */
export async function updateOperationalIncident(
  incidentId: string,
  input: UpdateOperationalIncidentInput,
  actorUserId: string,
): Promise<PublicOperationalIncident> {
  const existing = await operationalIncidentRepository.findByIncidentId(
    incidentId,
  );
  if (!existing) throw operationalIncidentNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.incidentStatus !== 'REPORTED') {
    throw operationalIncidentUpdateNotAllowedError();
  }
  if (input.occurredAt !== undefined) assertOccurrence(input.occurredAt);

  const nextStatus = input.operationalStatus;
  if (
    nextStatus !== undefined &&
    nextStatus !== existing.operationalStatus &&
    !canTransitionOperationalIncidentStatus(
      existing.operationalStatus,
      nextStatus,
    )
  ) {
    throw operationalIncidentInvalidTransitionError(
      existing.operationalStatus,
      nextStatus,
    );
  }

  await withTransaction(async (client) => {
    const foundation = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.severity !== undefined ? { severity: input.severity } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    };
    if (Object.keys(foundation).length > 0) {
      // BE-21A's own guarded update — it refuses anything not REPORTED.
      const updated = await incidentRepository.updateReported(
        incidentId,
        foundation,
        client,
      );
      if (!updated) throw operationalIncidentUpdateNotAllowedError();
    }

    await operationalIncidentRepository.update(
      incidentId,
      {
        ...(input.operationalCategory !== undefined
          ? { operationalCategory: input.operationalCategory }
          : {}),
        ...(input.occurredAt !== undefined
          ? { occurredAt: input.occurredAt }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      client,
    );

    if (nextStatus !== undefined && nextStatus !== existing.operationalStatus) {
      const moved = await operationalIncidentRepository.transitionStatus(
        incidentId,
        existing.operationalStatus,
        nextStatus,
        client,
      );
      if (!moved) {
        throw operationalIncidentInvalidTransitionError(
          existing.operationalStatus,
          nextStatus,
        );
      }
    }
  });

  const updated = await operationalIncidentRepository.findByIncidentId(
    incidentId,
  );
  if (!updated) throw operationalIncidentNotFoundError();

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    entityType: 'INCIDENT',
    entityId: updated.incidentId,
    eventType:
      nextStatus !== undefined && nextStatus !== existing.operationalStatus
        ? 'OPERATIONAL_INCIDENT_STATUS_CHANGED'
        : 'OPERATIONAL_INCIDENT_UPDATED',
    actorUserId,
    summary: `Operational Incident ${updated.incidentNumber} updated`,
    metadata: {
      fields: Object.keys(input),
      ...(nextStatus !== undefined && nextStatus !== existing.operationalStatus
        ? {
            fromOperationalStatus: existing.operationalStatus,
            toOperationalStatus: nextStatus,
          }
        : {}),
    },
  });
  return present(updated, actorUserId);
}

export { operationalIncidentTypeMismatchError };

export const operationalIncidentService = {
  createOperationalIncident,
  getOperationalIncident,
  listOperationalIncidents,
  toPublicOperationalIncident,
  updateOperationalIncident,
};

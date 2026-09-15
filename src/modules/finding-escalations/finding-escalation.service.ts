import { withTransaction } from '../../database';
import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { recordFindingEvent } from '../finding-history/finding-history.service';
import { findingNotFoundError, findingRepository } from '../findings';
import type { FindingRecord } from '../findings';
import {
  incidentNumberAlreadyExistsError,
  incidentRepository,
  isIncidentNumberUniqueViolation,
  resolveBuildingContext,
} from '../incidents';
import { recordOperationalEvent } from '../operational-events';
import { permissionService } from '../permissions';
import {
  findingEscalationAlreadyActiveError,
  findingEscalationBuildingMismatchError,
  findingEscalationClientMismatchError,
  findingEscalationFindingNotEscalatableError,
  findingEscalationNotFoundError,
  findingEscalationUpdateNotAllowedError,
} from './finding-escalation.errors';
import { findingEscalationRepository } from './finding-escalation.repository';
import {
  isEscalatableFindingStatus,
  type CreateFindingEscalationInput,
  type FindingEscalationAction,
  type FindingEscalationCompositeRecord,
  type FindingEscalationFilters,
  type PublicFindingEscalation,
  type UpdateFindingEscalationInput,
} from './finding-escalation.types';

/**
 * BE-21D — Finding Escalation service.
 *
 * An escalation is a SPECIALIZATION of the BE-21A foundation bound to an
 * existing BE-09 Finding. It raises INCIDENT-level visibility for that
 * Finding; it does not re-implement, mirror, or drive the Finding workflow:
 *   - The Incident row is created through BE-21A's repository with
 *     `incidentType` pinned to FINDING_ESCALATION.
 *   - Client and Building are DERIVED FROM THE FINDING, then checked with
 *     BE-21A's own `resolveBuildingContext` (which asserts Building access and
 *     re-derives the Client independently). A caller therefore cannot assert a
 *     context that contradicts BE-09, and cannot escalate into a Building they
 *     cannot reach.
 *   - Finding state is READ (to reject terminal Findings) and PROJECTED, never
 *     written. Nothing here calls a BE-09 transition.
 *   - Foundation + specialization are written in ONE transaction.
 *
 * BE-09 remains authoritative for Finding workflow and history; BE-21A for the
 * Incident record lifecycle. This module owns neither, which is why it has no
 * status enum of its own.
 */

/**
 * Resolves the Finding and validates it against the caller's context.
 *
 * Order matters and is pinned by tests:
 *   1. unknown Finding                → 404 FINDING_NOT_FOUND
 *   2. terminal Finding               → 400 (nothing left to escalate)
 *
 * Client/Building agreement is then established by DERIVING the Incident
 * context from the Finding itself and letting BE-21A re-derive the Client from
 * the Building. The explicit comparison below is a defence-in-depth assertion:
 * it can only fire if `findings.client_id` and the
 * Building → Property → Client chain have drifted, which would be a data
 * integrity fault rather than a caller error — better surfaced than silently
 * accepted.
 */
async function resolveFinding(findingId: string): Promise<FindingRecord> {
  const finding = await findingRepository.findById(findingId);
  if (!finding) throw findingNotFoundError();
  if (!isEscalatableFindingStatus(finding.status)) {
    throw findingEscalationFindingNotEscalatableError(finding.status);
  }
  return finding;
}

/**
 * Backend-authoritative available actions. A CANCELLED Incident yields none,
 * so the foundation stays authoritative over the specialization.
 *
 * Only `UPDATE_DETAILS` is ever offered: acting on the Finding belongs to
 * BE-09 and cancelling belongs to BE-21A. Mirroring their actions here would
 * imply this module can perform them.
 */
function resolveAvailableActions(
  record: FindingEscalationCompositeRecord,
  permissions: Set<string>,
): FindingEscalationAction[] {
  if (record.incidentStatus !== 'REPORTED') return [];
  if (!permissions.has('finding_escalation.manage')) return [];
  return ['UPDATE_DETAILS'];
}

export function toPublicFindingEscalation(
  record: FindingEscalationCompositeRecord,
  availableActions: FindingEscalationAction[],
): PublicFindingEscalation {
  return {
    id: record.incidentId,
    findingEscalationId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    incidentNumber: record.incidentNumber,
    incidentType: 'FINDING_ESCALATION',
    title: record.title,
    description: record.description,
    severity: record.severity,
    priority: record.priority,
    incidentStatus: record.incidentStatus,
    escalationReason: record.escalationReason,
    escalatedAt: record.escalatedAt.toISOString(),
    notes: record.notes,
    reportedByUserId: record.reportedByUserId,
    reportedAt: record.reportedAt.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    // A read-only projection of the live BE-09 Finding, never a copy.
    finding: {
      id: record.findingId,
      findingNumber: record.findingNumber,
      title: record.findingTitle,
      status: record.findingStatus,
      buildingId: record.findingBuildingId,
      stateChangedAt: record.findingStateChangedAt.toISOString(),
    },
    availableActions,
  };
}

async function present(
  record: FindingEscalationCompositeRecord,
  actorUserId: string,
): Promise<PublicFindingEscalation> {
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return toPublicFindingEscalation(
    record,
    resolveAvailableActions(record, permissions),
  );
}

export async function createFindingEscalation(
  input: CreateFindingEscalationInput,
  actorUserId: string,
): Promise<PublicFindingEscalation> {
  const finding = await resolveFinding(input.findingId);

  // Context is DERIVED from the Finding, never accepted from the caller.
  // BE-21A re-derives the Client from the Building and asserts access, so an
  // inaccessible Building fails here exactly as it would for any Incident.
  const { clientId } = await resolveBuildingContext(
    finding.buildingId,
    actorUserId,
  );
  // Defence in depth: BE-09's stored Client must agree with the Building's.
  if (finding.clientId !== clientId) {
    throw findingEscalationClientMismatchError();
  }

  const existingNumber = await incidentRepository.findByClientAndNumber(
    clientId,
    input.incidentNumber,
  );
  if (existingNumber) throw incidentNumberAlreadyExistsError();

  try {
    const incidentId = await withTransaction(async (client) => {
      // Serializes concurrent escalations of the SAME Finding. Taken before
      // the duplicate check so the check-then-insert cannot interleave.
      const locked = await findingEscalationRepository.lockFinding(
        finding.id,
        client,
      );
      if (!locked) throw findingNotFoundError();

      const active = await findingEscalationRepository.findActiveByFindingId(
        finding.id,
        client,
      );
      if (active) throw findingEscalationAlreadyActiveError();

      const incident = await incidentRepository.create(
        {
          clientId,
          buildingId: finding.buildingId,
          incidentNumber: input.incidentNumber,
          // BE-21D always pins the discriminator; callers cannot set it.
          incidentType: 'FINDING_ESCALATION',
          title: input.title,
          description: input.description ?? null,
          severity: input.severity ?? 'MEDIUM',
          priority: input.priority ?? 'MEDIUM',
          // An escalation inherits the Finding's context; it does not carry a
          // BE-04 location refinement of its own.
          locationType: null,
          floorId: null,
          areaId: null,
          roomId: null,
          spaceId: null,
          functionalLocationId: null,
          reportedByUserId: actorUserId,
          reportedAt: new Date(),
        },
        client,
      );
      await findingEscalationRepository.create(
        {
          incidentId: incident.id,
          findingId: finding.id,
          escalationReason: input.escalationReason,
          notes: input.notes ?? null,
          createdByUserId: actorUserId,
        },
        client,
      );
      return incident.id;
    });

    const created = await findingEscalationRepository.findByIncidentId(
      incidentId,
    );
    if (!created) throw findingEscalationNotFoundError();

    await recordOperationalEvent({
      clientId: created.clientId,
      buildingId: created.buildingId,
      entityType: 'INCIDENT',
      entityId: created.incidentId,
      eventType: 'FINDING_ESCALATION_REPORTED',
      actorUserId,
      summary: `Finding ${created.findingNumber} escalated as Incident ${created.incidentNumber}`,
      metadata: {
        incidentNumber: created.incidentNumber,
        findingId: created.findingId,
        findingNumber: created.findingNumber,
        escalationReason: created.escalationReason,
        findingStatus: created.findingStatus,
      },
    });

    // The escalation is also recorded on the FINDING's own BE-09 history, so
    // the Finding timeline shows it. This reuses BE-09's history primitive
    // rather than creating a parallel history: it appends an event and does
    // NOT touch Finding state.
    await recordFindingEvent({
      findingId: created.findingId,
      clientId: created.findingClientId,
      buildingId: created.findingBuildingId,
      eventType: 'FINDING_ESCALATED',
      actorUserId,
      summary: `Finding escalated as Incident ${created.incidentNumber}`,
      metadata: {
        incidentId: created.incidentId,
        incidentNumber: created.incidentNumber,
        escalationReason: created.escalationReason,
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

export async function getFindingEscalation(
  incidentId: string,
  actorUserId: string,
): Promise<PublicFindingEscalation> {
  const record = await findingEscalationRepository.findByIncidentId(incidentId);
  if (!record) throw findingEscalationNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  return present(record, actorUserId);
}

export async function listFindingEscalations(
  filters: FindingEscalationFilters,
  actorUserId: string,
): Promise<PublicFindingEscalation[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const records = await findingEscalationRepository.list(filters, buildingIds);
  const permissions = new Set(
    await permissionService.resolvePermissionsForUser(actorUserId),
  );
  return records.map((record) =>
    toPublicFindingEscalation(
      record,
      resolveAvailableActions(record, permissions),
    ),
  );
}

/**
 * Updates escalation details and, where supplied, the foundation metadata —
 * atomically. The BE-21A lifecycle gates the whole operation. The Finding
 * binding is immutable, and nothing here can alter the Finding.
 */
export async function updateFindingEscalation(
  incidentId: string,
  input: UpdateFindingEscalationInput,
  actorUserId: string,
): Promise<PublicFindingEscalation> {
  const existing = await findingEscalationRepository.findByIncidentId(
    incidentId,
  );
  if (!existing) throw findingEscalationNotFoundError();
  await contextAccessService.assertBuildingAccess(
    actorUserId,
    existing.buildingId,
  );
  if (existing.incidentStatus !== 'REPORTED') {
    throw findingEscalationUpdateNotAllowedError();
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
      if (!updated) throw findingEscalationUpdateNotAllowedError();
    }

    await findingEscalationRepository.update(
      incidentId,
      {
        ...(input.escalationReason !== undefined
          ? { escalationReason: input.escalationReason }
          : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      client,
    );
  });

  const updated = await findingEscalationRepository.findByIncidentId(incidentId);
  if (!updated) throw findingEscalationNotFoundError();

  await recordOperationalEvent({
    clientId: updated.clientId,
    buildingId: updated.buildingId,
    entityType: 'INCIDENT',
    entityId: updated.incidentId,
    eventType: 'FINDING_ESCALATION_UPDATED',
    actorUserId,
    summary: `Finding Escalation ${updated.incidentNumber} updated`,
    metadata: {
      findingId: updated.findingId,
      fields: Object.keys(input),
    },
  });
  return present(updated, actorUserId);
}

export {
  findingEscalationAlreadyActiveError,
  findingEscalationBuildingMismatchError,
};

export const findingEscalationService = {
  createFindingEscalation,
  getFindingEscalation,
  listFindingEscalations,
  toPublicFindingEscalation,
  updateFindingEscalation,
};

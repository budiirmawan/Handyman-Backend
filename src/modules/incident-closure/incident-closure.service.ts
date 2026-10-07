import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { incidentNotFoundError, incidentRepository } from '../incidents';
import { recordOperationalEvent } from '../operational-events';
import {
  incidentAlreadyClosedError,
  incidentClosureNotAllowedError,
} from './incident-closure.errors';
import { incidentClosureRepository } from './incident-closure.repository';
import {
  evaluateClosureBlockers,
  isCloseable,
} from './incident-closure.rules';
import type {
  CloseIncidentInput,
  IncidentClosureFacts,
  IncidentClosureFilters,
  IncidentClosureStatus,
} from './incident-closure.types';

/**
 * BE-21K — Incident Closure service.
 *
 * Closure seals a BE-21A Incident once its remedy has been carried out and
 * independently verified by BE-21J. It reuses the existing foundation
 * throughout:
 *   - the Incident is the closed thing, and the write goes through
 *     `incidentRepository`, so nothing else can move an Incident's status;
 *   - corrective actions and their verifications are READ to judge
 *     readiness, never duplicated;
 *   - Building access is asserted against the Incident, so isolation is
 *     inherited from BE-21A rather than re-derived.
 *
 * THE BACKEND IS AUTHORITATIVE. Readiness is computed here from current
 * facts, and the same rules that EXPLAIN a refusal are the ones that ENFORCE
 * it — a client can never talk the backend into a closure the rules forbid.
 */

/** Projects gathered facts through the pure rules into the public verdict. */
export function toClosureStatus(
  facts: IncidentClosureFacts,
  evaluatedAt = new Date(),
): IncidentClosureStatus {
  const blockers = evaluateClosureBlockers(facts);
  return {
    incidentId: facts.incidentId,
    clientId: facts.clientId,
    buildingId: facts.buildingId,
    incidentNumber: facts.incidentNumber,
    incidentType: facts.incidentType,
    title: facts.title,
    severity: facts.severity,
    priority: facts.priority,
    incidentStatus: facts.status,
    reportedAt: facts.reportedAt.toISOString(),
    // Derived from the list, so the two can never contradict each other.
    closeable: isCloseable(blockers),
    blockers,
    closed: facts.status === 'CLOSED',
    closedAt: facts.closedAt?.toISOString() ?? null,
    closedByUserId: facts.closedByUserId,
    closureNotes: facts.closureNotes,
    facts: {
      requiredActionCount: facts.requiredActionCount,
      unresolvedActionCount: facts.unresolvedActionCount,
      unverifiedActionCount: facts.unverifiedActionCount,
      verifiedActionCount: facts.verifiedActionCount,
      reworkRequiredCount: facts.reworkRequiredCount,
      rejectedVerificationCount: facts.rejectedVerificationCount,
      pendingVerificationCount: facts.pendingVerificationCount,
    },
    evaluatedAt: evaluatedAt.toISOString(),
  };
}

/**
 * Loads closure facts and asserts Building access.
 *
 * Unknown Incident 404 → inaccessible Building 403, matching every other
 * BE-21 PART. Access is asserted before any fact is returned, so closure
 * status never leaks another Client's Incident.
 */
async function resolveFacts(
  incidentId: string,
  actorUserId: string,
): Promise<IncidentClosureFacts> {
  const facts = await incidentClosureRepository.findFactsByIncidentId(incidentId);
  if (!facts) throw incidentNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, facts.buildingId);
  return facts;
}

/** Read-only closure readiness for one Incident. */
export async function getClosureStatus(
  incidentId: string,
  actorUserId: string,
): Promise<IncidentClosureStatus> {
  return toClosureStatus(await resolveFacts(incidentId, actorUserId));
}

/**
 * Closure readiness across the caller's accessible Incidents.
 *
 * The `closeable` filter is applied AFTER evaluation because readiness is
 * computed, not stored — there is no column to filter on in SQL.
 */
export async function listClosureStatuses(
  filters: IncidentClosureFilters,
  actorUserId: string,
): Promise<IncidentClosureStatus[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const facts = await incidentClosureRepository.listFacts(filters, buildingIds);
  // ONE instant for the whole page, so two Incidents cannot be judged against
  // different clocks within a single response.
  const evaluatedAt = new Date();
  const statuses = facts.map((row) => toClosureStatus(row, evaluatedAt));
  return filters.closeable === undefined
    ? statuses
    : statuses.filter((status) => status.closeable === filters.closeable);
}

/**
 * Closes the Incident.
 *
 * The refusal path is deliberately layered:
 *   1. Already CLOSED → 409, distinct from a readiness failure, because
 *      CLOSED is terminal and retrying will never help.
 *   2. Any other blocker → 400 carrying the FIRST blocker's message, so the
 *      caller learns the actual reason. The full list stays available from
 *      the status endpoint, which evaluates the SAME rules.
 *   3. The status-guarded UPDATE (`WHERE status = 'REPORTED'`) is the final
 *      authority. It is what makes duplicate closure impossible under
 *      concurrency: the loser matches no row and is reported, so a recorded
 *      closure is never overwritten or re-stamped with a later timestamp.
 *
 * History is preserved — closure adds a status and metadata and rewrites
 * nothing. The corrective actions, their verifications, and the BE-07 event
 * log all survive and stay readable afterwards.
 */
export async function closeIncident(
  incidentId: string,
  input: CloseIncidentInput,
  actorUserId: string,
): Promise<IncidentClosureStatus> {
  const facts = await resolveFacts(incidentId, actorUserId);
  const blockers = evaluateClosureBlockers(facts);

  if (blockers.length > 0) {
    if (facts.status === 'CLOSED') throw incidentAlreadyClosedError();
    throw incidentClosureNotAllowedError(blockers[0].message);
  }

  const closed = await incidentRepository.closeReported(incidentId, {
    closedByUserId: actorUserId,
    closureNotes: input.closureNotes?.trim() || null,
  });
  // Lost the race to a concurrent close or cancel; the recorded outcome
  // stands rather than being overwritten.
  if (!closed) throw incidentAlreadyClosedError();

  await recordOperationalEvent({
    clientId: closed.clientId,
    buildingId: closed.buildingId,
    entityType: 'INCIDENT',
    entityId: closed.id,
    eventType: 'INCIDENT_CLOSED',
    actorUserId,
    summary: `Incident ${closed.incidentNumber} closed`,
    metadata: {
      previousStatus: facts.status,
      // The evidence the closure rested on, captured at the moment it was
      // taken, so the decision stays auditable even as later reads recompute.
      requiredActionCount: facts.requiredActionCount,
      verifiedActionCount: facts.verifiedActionCount,
    },
  });

  return toClosureStatus(
    await incidentClosureRepository.findFactsByIncidentId(incidentId) ?? {
      ...facts,
      status: 'CLOSED',
      closedAt: closed.closedAt,
      closedByUserId: closed.closedByUserId,
      closureNotes: closed.closureNotes,
    },
  );
}

export const incidentClosureService = {
  closeIncident,
  getClosureStatus,
  listClosureStatuses,
  toClosureStatus,
};

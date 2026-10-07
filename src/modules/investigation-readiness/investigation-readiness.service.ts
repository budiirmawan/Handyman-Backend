import { contextAccessService, getAccessibleBuildingIds } from '../context-access';
import { incidentNotFoundError } from '../incidents';
import {
  evaluateReadinessBlockers,
  isReady,
} from './investigation-readiness.rules';
import { investigationReadinessRepository } from './investigation-readiness.repository';
import type {
  IncidentReadinessFacts,
  InvestigationReadiness,
  InvestigationReadinessFilters,
} from './investigation-readiness.types';

/**
 * BE-21F — Investigation Readiness service.
 *
 * Every path here is READ-ONLY. There is no create, no update, no state
 * change, and no persisted readiness anywhere in this module: the verdict is
 * recomputed from current facts on each request and returned.
 *
 * The backend is authoritative. It ships `ready` AND the `blockers` that
 * justify it, so a frontend can explain the outcome without ever re-deriving
 * the rules — if a client disagrees with the backend, the client is wrong.
 */

/** Projects gathered facts through the pure rules into the public verdict. */
export function toInvestigationReadiness(
  facts: IncidentReadinessFacts,
  evaluatedAt = new Date(),
): InvestigationReadiness {
  const blockers = evaluateReadinessBlockers(facts);
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
    ready: isReady(blockers),
    blockers,
    facts: {
      incidentStatus: facts.status,
      hasDescription: facts.hasDescription,
      hasTypeDetail: facts.hasTypeDetail,
      immediateActionCount: facts.immediateActionCount,
      unsettledImmediateActionCount: facts.unsettledImmediateActionCount,
      completedImmediateActionCount: facts.completedImmediateActionCount,
    },
    evaluatedAt: evaluatedAt.toISOString(),
  };
}

/**
 * Evaluates readiness for one Incident.
 *
 * Unknown Incident 404 → inaccessible Building 403, matching BE-21A/E so the
 * ordering is consistent across the foundation. Access is asserted before any
 * fact is returned, so readiness never leaks the state of another Client's
 * Incident.
 */
export async function getInvestigationReadiness(
  incidentId: string,
  actorUserId: string,
): Promise<InvestigationReadiness> {
  const facts =
    await investigationReadinessRepository.findFactsByIncidentId(incidentId);
  if (!facts) throw incidentNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, facts.buildingId);
  return toInvestigationReadiness(facts);
}

/**
 * Evaluates readiness across the caller's accessible Incidents.
 *
 * The `ready` filter is applied AFTER evaluation because readiness is
 * computed, not stored — there is no column to filter on, and inventing one
 * is exactly what this PART must not do. Building scoping still happens in
 * SQL, so this filtering never sees an out-of-scope Incident.
 */
export async function listInvestigationReadiness(
  filters: InvestigationReadinessFilters,
  actorUserId: string,
): Promise<InvestigationReadiness[]> {
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(
      actorUserId,
      filters.buildingId,
    );
  }
  const buildingIds = await getAccessibleBuildingIds(actorUserId);
  const facts = await investigationReadinessRepository.listFacts(
    filters,
    buildingIds,
  );
  // One timestamp for the whole batch: these verdicts share an evaluation.
  const evaluatedAt = new Date();
  const evaluated = facts.map((row) =>
    toInvestigationReadiness(row, evaluatedAt),
  );
  return filters.ready === undefined
    ? evaluated
    : evaluated.filter((row) => row.ready === filters.ready);
}

export const investigationReadinessService = {
  getInvestigationReadiness,
  listInvestigationReadiness,
  toInvestigationReadiness,
};

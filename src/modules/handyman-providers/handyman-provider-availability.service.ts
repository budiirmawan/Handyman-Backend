import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import {
  handymanAssignmentContextMismatchError,
  handymanScopeAssignmentRepository,
} from '../handyman-scope-assignments';
import { handymanWorkSessionRepository } from '../handyman-work-sessions';
import { workforceRepository } from '../workforce';
import { handymanProviderContextRepository } from './handyman-provider-context.repository';
import type {
  HandymanProviderContextRecord,
  PublicHandymanProviderContext,
} from './handyman-provider-context.types';
import type {
  HandymanAssignableCrewLeadProjection,
  HandymanCrewOccupancyProjection,
  ListHandymanProviderAvailabilityInput,
  PublicHandymanAssignableCrewAvailability,
  PublicHandymanProviderAvailabilityItem,
} from './handyman-provider-availability.types';
import { handymanWorkerContextRepository } from './handyman-worker-context.repository';
import { handymanWorkCrewRepository } from './handyman-work-crew.repository';
import type {
  HandymanWorkCrewRecord,
  PublicHandymanWorkCrew,
} from './handyman-work-crew.types';

/**
 * CR-HM-17 GAP PART 02 (B4) — Handyman Provider Availability read projection
 * service.
 *
 * Bounded read-only projection over existing CR-HM-04, CR-HM-04A, and CR-HM-08
 * authorities:
 *   - Returns only ACTIVE provider contexts in the accessible Client
 *   - Returns only assignable ACTIVE crews that satisfy the frozen CR-HM-04 /
 *     CR-HM-04A Lead eligibility invariant (current Lead with ACTIVE
 *     membership, ACTIVE worker context under the same provider/Client, and
 *     non-null login-capable `workforce_profiles.userId`)
 *   - Returns active assignment (`handyman_execution_scope_assignments`
 *     where `status = 'ACTIVE'`) and active work-session
 *     (`handyman_work_sessions` where `status <> 'CHECKED_OUT'`) occupancy
 *     facts per assignable crew
 *
 * Enforces `contextAccessService.canAccessClient(actorUserId, clientId)`
 * on the contractual clientId-only path; when `executionScopeId` is
 * supplied, the BE-02G exact-Building guard against the loaded scope
 * applies instead (CR-HM-SEC-02 PART 04, decision D4).
 * Does not create availability or lifecycle authority; no assignment commands;
 * no FM/SaaS fallback.
 */

function assertUuid(value: string | undefined, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(normalized)) {
    throw AppError.validation('Provider availability query validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return normalized.toLowerCase();
}

function toPublicProviderContext(
  record: HandymanProviderContextRecord,
): PublicHandymanProviderContext {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toPublicCrew(
  record: HandymanWorkCrewRecord,
): PublicHandymanWorkCrew {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Evaluate the frozen CR-HM-04 / CR-HM-04A Lead eligibility invariant for an
 * ACTIVE crew:
 *   current Lead (`MAX(lead_seq)`) -> ACTIVE membership -> ACTIVE worker
 *   context in same provider/Client -> `workforce_profiles.userId !== null`.
 * Returns `null` when the crew's current Lead is not eligible (never throws or
 * fabricates an identity).
 */
async function resolveAssignableCrewLead(
  clientId: string,
  providerContextId: string,
  crew: HandymanWorkCrewRecord,
): Promise<HandymanAssignableCrewLeadProjection | null> {
  if (
    crew.status !== 'ACTIVE' ||
    crew.clientId !== clientId ||
    crew.handymanProviderContextId !== providerContextId
  ) {
    return null;
  }

  const lead = await handymanWorkCrewRepository.findCurrentLead(
    undefined,
    crew.id,
  );
  if (
    !lead ||
    lead.clientId !== clientId ||
    lead.handymanCrewId !== crew.id
  ) {
    return null;
  }

  const membership = await handymanWorkCrewRepository.findMembershipById(
    undefined,
    lead.handymanCrewMembershipId,
  );
  if (
    !membership ||
    membership.status !== 'ACTIVE' ||
    membership.handymanCrewId !== crew.id ||
    membership.clientId !== clientId
  ) {
    return null;
  }

  const workerContext = await handymanWorkerContextRepository.findById(
    undefined,
    membership.handymanWorkerContextId,
  );
  if (
    !workerContext ||
    workerContext.status !== 'ACTIVE' ||
    workerContext.handymanProviderContextId !== providerContextId ||
    workerContext.clientId !== clientId
  ) {
    return null;
  }

  const profile = await workforceRepository.findById(
    workerContext.workforceProfileId,
  );
  if (!profile || profile.userId === null) {
    return null;
  }

  return {
    id: lead.id,
    leadSeq: lead.leadSeq,
    membershipId: membership.id,
    workerContextId: workerContext.id,
    workforceProfileId: profile.id,
    userId: profile.userId,
    designatedByUserId: lead.designatedByUserId,
    designatedAt: lead.designatedAt.toISOString(),
  };
}

/**
 * Resolve CR-HM-04A active assignment and CR-HM-08 active work-session
 * occupancy facts for an assignable ACTIVE crew.
 */
async function resolveCrewOccupancy(
  clientId: string,
  crewId: string,
): Promise<HandymanCrewOccupancyProjection> {
  const activeAssignments =
    await handymanScopeAssignmentRepository.listActiveAssignmentsByCrew(
      undefined,
      clientId,
      crewId,
    );

  const activeAssignmentIds: string[] = [];
  const activeExecutionScopeIds: string[] = [];
  const activeWorkSessionIds: string[] = [];

  for (const assignment of activeAssignments) {
    activeAssignmentIds.push(assignment.id);
    activeExecutionScopeIds.push(assignment.executionScopeId);

    const activeSession =
      await handymanWorkSessionRepository.findActiveWorkSessionByExecutionScope(
        undefined,
        assignment.executionScopeId,
      );
    if (
      activeSession &&
      activeSession.clientId === clientId &&
      activeSession.assignmentId === assignment.id &&
      activeSession.status !== 'CHECKED_OUT'
    ) {
      activeWorkSessionIds.push(activeSession.id);
    }
  }

  return {
    activeAssignmentCount: activeAssignmentIds.length,
    activeAssignmentIds,
    activeExecutionScopeIds,
    activeWorkSessionCount: activeWorkSessionIds.length,
    activeWorkSessionIds,
    hasActiveAssignment: activeAssignmentIds.length > 0,
    hasActiveWorkSession: activeWorkSessionIds.length > 0,
  };
}

export async function listHandymanProviderAvailability(
  input: ListHandymanProviderAvailabilityInput,
  actorUserId: string,
): Promise<PublicHandymanProviderAvailabilityItem[]> {
  assertUuid(actorUserId, 'actorUserId');

  const clientId =
    input.clientId !== undefined
      ? assertUuid(input.clientId, 'clientId')
      : undefined;
  const executionScopeId =
    input.executionScopeId !== undefined
      ? assertUuid(input.executionScopeId, 'executionScopeId')
      : undefined;
  const providerContextId =
    input.providerContextId !== undefined
      ? assertUuid(input.providerContextId, 'providerContextId')
      : undefined;

  if (!clientId && !executionScopeId) {
    throw AppError.validation(
      'Provider availability query validation failed.',
      [
        {
          field: 'clientId',
          message: 'clientId or executionScopeId is required.',
        },
      ],
    );
  }

  let resolvedClientId = clientId as string;
  let scopeBuildingId: string | null = null;
  if (executionScopeId) {
    const scope = await handymanScopeAssignmentRepository.findScopeById(
      undefined,
      executionScopeId,
    );
    if (!scope) throw handymanExecutionScopeNotFoundError();
    if (clientId && clientId !== scope.clientId) {
      throw handymanAssignmentContextMismatchError();
    }
    resolvedClientId = scope.clientId;
    scopeBuildingId = scope.buildingId;
  }

  if (scopeBuildingId !== null) {
    // CR-HM-SEC-02 PART 04 (PART 00A frozen decision D4) — the
    // executionScopeId path resolves a building-scoped scope
    // (`building_id UUID NOT NULL`, migration 0395), so the BE-02G
    // exact-Building guard — not the client-level `canAccessClient`
    // shortcut — is the authoritative wall, enforced BEFORE any
    // occupancy projection. A same-Client SIBLING-building actor must
    // not receive occupancy identifiers. The contractual clientId-only
    // path below keeps its client-level authorization verbatim.
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: resolvedClientId,
      buildingId: scopeBuildingId,
    });
  } else if (
    !(await contextAccessService.canAccessClient(actorUserId, resolvedClientId))
  ) {
    throw buildingAccessDeniedError();
  }

  const activeProviders =
    await handymanProviderContextRepository.listActiveByClient(
      undefined,
      resolvedClientId,
      providerContextId,
    );

  const items: PublicHandymanProviderAvailabilityItem[] = [];
  for (const provider of activeProviders) {
    const publicProvider = toPublicProviderContext(provider);
    const activeCrews =
      await handymanWorkCrewRepository.listActiveCrewsByProviderContext(
        undefined,
        resolvedClientId,
        provider.id,
      );

    const assignableCrews: PublicHandymanAssignableCrewAvailability[] = [];
    for (const crew of activeCrews) {
      const lead = await resolveAssignableCrewLead(
        resolvedClientId,
        provider.id,
        crew,
      );
      if (!lead) continue;

      const occupancy = await resolveCrewOccupancy(resolvedClientId, crew.id);
      assignableCrews.push({
        ...toPublicCrew(crew),
        lead,
        occupancy,
        activeAssignmentCount: occupancy.activeAssignmentCount,
        activeWorkSessionCount: occupancy.activeWorkSessionCount,
        hasActiveAssignment: occupancy.hasActiveAssignment,
        hasActiveWorkSession: occupancy.hasActiveWorkSession,
      });
    }

    items.push({
      ...publicProvider,
      providerContext: publicProvider,
      crews: assignableCrews,
    });
  }

  return items;
}

export const handymanProviderAvailabilityService = {
  listHandymanProviderAvailability,
};

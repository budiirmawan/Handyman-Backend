import { randomUUID } from 'node:crypto';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { workforceRepository } from '../workforce';
import {
  assignmentResponseRepository,
  notifyExecutionScopeCrewLeadAssignedPending,
  notifyExecutionScopeCrewLeadSuperseded,
} from '../assignment-responses';
import { handymanProviderContextRepository } from './handyman-provider-context.repository';
import { handymanProviderContextNotFoundError } from './handyman-provider-context.errors';
import { handymanWorkerContextRepository } from './handyman-worker-context.repository';
import { handymanWorkerContextNotFoundError } from './handyman-worker-context.errors';
import { handymanWorkCrewRepository } from './handyman-work-crew.repository';
import {
  handymanCrewCodeAlreadyExistsError,
  handymanCrewInvalidStatusError,
  handymanCrewLeadInvalidError,
  handymanCrewLeadMembershipLockedError,
  handymanCrewLeadRequiredError,
  handymanCrewMemberAlreadyActiveError,
  handymanCrewMemberNotFoundError,
  handymanCrewNotFoundError,
} from './handyman-work-crew.errors';
import {
  isHandymanCrewStatus,
  type AddHandymanCrewMemberInput,
  type CreateHandymanWorkCrewInput,
  type DesignateHandymanCrewLeadInput,
  type HandymanCrewMembershipRecord,
  type HandymanWorkCrewRecord,
  type PublicHandymanCrewLead,
  type PublicHandymanCrewMembership,
  type PublicHandymanWorkCrew,
} from './handyman-work-crew.types';

/**
 * CR-HM-04 PART 03 — Handyman Work Crew + Membership + Lead service
 * (FROZEN F3/F4/F5/F8/F9/F10).
 *
 * F4 paradox rule (FROZEN): creation is TRANSACTIONAL — a crew comes into
 * existence ACTIVE* only together with its initial validated Lead member;
 * no lead-less ACTIVE crew state and no DRAFT status ever exists. Lead
 * designation is an APPEND-ONLY history fact (current = MAX lead_seq);
 * previous designations are never overwritten (F10).
 *
 * *Crew != teams; Membership != attendance != work session != billable
 * time; Lead != provider assignment != specialist referral.
 */

const CODE_UNIQUE = 'handyman_work_crews_code_unique';
const MEMBER_ACTIVE_UNIQUE = 'handyman_crew_memberships_active_unique';

function pgUnique(error: unknown, name: string): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return candidate?.code === '23505' && candidate?.constraint === name;
}

function ensureUuid(value: string, field: string): void {
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

function ensureText(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < 1 || text.length > max) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} is required (1-${max} characters).` },
    ]);
  }
  return text;
}

function toPublicCrew(crew: HandymanWorkCrewRecord): PublicHandymanWorkCrew {
  return {
    ...crew,
    createdAt: crew.createdAt.toISOString(),
    updatedAt: crew.updatedAt.toISOString(),
  };
}

function toPublicMember(
  m: HandymanCrewMembershipRecord,
): PublicHandymanCrewMembership {
  return { ...m, createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString() };
}

async function assertRealm(actorUserId: string, clientId: string): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

/**
 * F2/F4 worker eligibility: ACTIVE worker context under the SAME provider
 * context and the SAME client (realms derive from the caller-free chain).
 */
async function eligibleWorkerContext(
  executor: Parameters<typeof handymanWorkerContextRepository.findById>[0],
  workerContextId: string,
  providerContextId: string,
  clientId: string,
) {
  const context = await handymanWorkerContextRepository.findById(
    executor,
    workerContextId,
  );
  if (!context) throw handymanWorkerContextNotFoundError();
  if (
    context.status !== 'ACTIVE' ||
    context.handymanProviderContextId !== providerContextId ||
    context.clientId !== clientId
  ) {
    throw handymanCrewLeadInvalidError();
  }
  return context;
}

/** F4: the underlying person must hold a non-null app userId (no helper Lead). */
async function assertProfileHasUser(workforceProfileId: string): Promise<void> {
  const profile = await workforceRepository.findById(workforceProfileId);
  if (!profile || profile.userId === null) {
    throw handymanCrewLeadInvalidError();
  }
}

/** Create the ACTIVE crew transactionally with its initial Lead member (F4). */
export async function createHandymanWorkCrew(
  input: CreateHandymanWorkCrewInput,
  actorUserId: string,
): Promise<{
  crew: PublicHandymanWorkCrew;
  leadMembership: PublicHandymanCrewMembership;
  lead: PublicHandymanCrewLead;
}> {
  ensureUuid(input.handymanProviderContextId, 'handymanProviderContextId');
  ensureUuid(input.leadWorkerContextId, 'leadWorkerContextId');
  ensureUuid(actorUserId, 'actorUserId');
  const code = ensureText(input.code, 'code', 64);
  const name = ensureText(input.name, 'name', 200);

  const providerContext = await handymanProviderContextRepository.findById(
    undefined,
    input.handymanProviderContextId,
  );
  if (!providerContext) throw handymanProviderContextNotFoundError();
  await assertRealm(actorUserId, providerContext.clientId);

  try {
    return await withTransaction(async (tx) => {
      const provider = await handymanProviderContextRepository.lockById(
        tx,
        providerContext.id,
      );
      if (!provider) throw handymanProviderContextNotFoundError();
      if (provider.status !== 'ACTIVE') throw handymanCrewLeadRequiredError();

      const workerContext = await eligibleWorkerContext(
        tx,
        input.leadWorkerContextId,
        provider.id,
        provider.clientId,
      );
      await assertProfileHasUser(workerContext.workforceProfileId);

      const crew = await handymanWorkCrewRepository.insertCrew(
        tx,
        {
          clientId: provider.clientId,
          handymanProviderContextId: provider.id,
          code,
          name,
          createdByUserId: actorUserId,
        },
        actorUserId,
      );
      const membership = await handymanWorkCrewRepository.insertMembership(
        tx,
        {
          clientId: provider.clientId,
          handymanCrewId: crew.id,
          handymanWorkerContextId: workerContext.id,
          createdByUserId: actorUserId,
        },
        actorUserId,
      );
      const lead = await handymanWorkCrewRepository.appendLead(
        tx,
        {
          clientId: provider.clientId,
          handymanCrewId: crew.id,
          handymanCrewMembershipId: membership.id,
          designatedByUserId: actorUserId,
        },
        actorUserId,
      );

      const journalBase = {
        clientId: provider.clientId,
        actorUserId,
      };
      await recordOperationalEvent(
        {
          ...journalBase,
          eventType: 'HANDYMAN_CREW_CREATED',
          entityType: 'HANDYMAN_WORK_CREW',
          entityId: crew.id,
          summary: `Handyman work crew created (ACTIVE): ${code}.`,
          metadata: {
            crewId: crew.id,
            providerContextId: provider.id,
            leadMembershipId: membership.id,
            leadWorkerContextId: workerContext.id,
          },
        },
        tx,
      );
      await recordOperationalEvent(
        {
          ...journalBase,
          eventType: 'HANDYMAN_CREW_MEMBER_ADDED',
          entityType: 'HANDYMAN_WORK_CREW',
          entityId: crew.id,
          summary: 'Crew member added (initial Lead member).',
          metadata: {
            crewId: crew.id,
            membershipId: membership.id,
            workerContextId: workerContext.id,
            asLead: true,
          },
        },
        tx,
      );
      await recordOperationalEvent(
        {
          ...journalBase,
          eventType: 'HANDYMAN_CREW_LEAD_DESIGNATED',
          entityType: 'HANDYMAN_WORK_CREW',
          entityId: crew.id,
          summary: 'Initial Lead Worker designated.',
          metadata: {
            crewId: crew.id,
            leadMembershipId: membership.id,
            workerContextId: workerContext.id,
            fromLeadMembershipId: null,
          },
        },
        tx,
      );

      return {
        crew: toPublicCrew(crew),
        leadMembership: toPublicMember(membership),
        lead: { ...lead, designatedAt: lead.designatedAt.toISOString() },
      };
    });
  } catch (error) {
    if (pgUnique(error, CODE_UNIQUE)) throw handymanCrewCodeAlreadyExistsError();
    if (pgUnique(error, MEMBER_ACTIVE_UNIQUE)) {
      throw handymanCrewMemberAlreadyActiveError();
    }
    throw error;
  }
}

/** Add an ordinary member (helper: login-less allowed; never Lead here). */
export async function addHandymanCrewMember(
  input: AddHandymanCrewMemberInput,
  actorUserId: string,
): Promise<PublicHandymanCrewMembership> {
  ensureUuid(input.handymanCrewId, 'handymanCrewId');
  ensureUuid(input.handymanWorkerContextId, 'handymanWorkerContextId');
  ensureUuid(actorUserId, 'actorUserId');

  const crew = await handymanWorkCrewRepository.findCrewById(
    undefined,
    input.handymanCrewId,
  );
  if (!crew) throw handymanCrewNotFoundError();
  await assertRealm(actorUserId, crew.clientId);

  try {
    return await withTransaction(async (tx) => {
      const locked = await handymanWorkCrewRepository.lockCrewById(tx, crew.id);
      if (!locked) throw handymanCrewNotFoundError();
      if (locked.status !== 'ACTIVE') throw handymanCrewInvalidStatusError();

      const workerContext = await eligibleWorkerContext(
        tx,
        input.handymanWorkerContextId,
        locked.handymanProviderContextId,
        locked.clientId,
      );

      const existing = await handymanWorkCrewRepository.findActiveMembership(
        tx,
        locked.id,
        workerContext.id,
      );
      if (existing) throw handymanCrewMemberAlreadyActiveError();

      const membership = await handymanWorkCrewRepository.insertMembership(
        tx,
        {
          clientId: locked.clientId,
          handymanCrewId: locked.id,
          handymanWorkerContextId: workerContext.id,
          createdByUserId: actorUserId,
        },
        actorUserId,
      );

      await recordOperationalEvent(
        {
          clientId: locked.clientId,
          eventType: 'HANDYMAN_CREW_MEMBER_ADDED',
          entityType: 'HANDYMAN_WORK_CREW',
          entityId: locked.id,
          actorUserId,
          summary: 'Crew member added.',
          metadata: {
            crewId: locked.id,
            membershipId: membership.id,
            workerContextId: workerContext.id,
            asLead: false,
          },
        },
        tx,
      );

      return toPublicMember(membership);
    });
  } catch (error) {
    if (pgUnique(error, MEMBER_ACTIVE_UNIQUE)) {
      throw handymanCrewMemberAlreadyActiveError();
    }
    throw error;
  }
}

/** Membership lifecycle: ACTIVE ⇄ INACTIVE; the current Lead is locked. */
export async function setHandymanCrewMemberStatus(
  membershipId: string,
  status: string,
  actorUserId: string,
): Promise<PublicHandymanCrewMembership> {
  ensureUuid(membershipId, 'membershipId');
  ensureUuid(actorUserId, 'actorUserId');
  if (!isHandymanCrewStatus(status)) throw handymanCrewInvalidStatusError();

  return withTransaction(async (tx) => {
    const membership = await handymanWorkCrewRepository.lockMembershipById(
      tx,
      membershipId,
    );
    if (!membership) throw handymanCrewMemberNotFoundError();
    await assertRealm(actorUserId, membership.clientId);
    if (membership.status === status) throw handymanCrewInvalidStatusError();

    // F4 invariant: current Lead membership can never deactivate.
    const currentLead = await handymanWorkCrewRepository.findCurrentLead(
      tx,
      membership.handymanCrewId,
    );
    if (
      status === 'INACTIVE' &&
      currentLead?.handymanCrewMembershipId === membership.id
    ) {
      throw handymanCrewLeadMembershipLockedError();
    }

    const projected = await handymanWorkCrewRepository.updateMembershipStatus(
      tx,
      membershipId,
      status,
    );
    if (!projected) throw handymanCrewMemberNotFoundError();

    await recordOperationalEvent(
      {
        clientId: membership.clientId,
        eventType: 'HANDYMAN_CREW_MEMBER_STATUS_CHANGED',
        entityType: 'HANDYMAN_WORK_CREW',
        entityId: membership.handymanCrewId,
        actorUserId,
        summary: `Crew member status: ${membership.status} → ${status}.`,
        metadata: {
          crewId: membership.handymanCrewId,
          membershipId: membership.id,
          workerContextId: membership.handymanWorkerContextId,
          fromStatus: membership.status,
          toStatus: status,
        },
      },
      tx,
    );

    return toPublicMember(projected);
  });
}

/** Designate a new Lead (append-only history; current = latest). */
export async function designateHandymanCrewLead(
  input: DesignateHandymanCrewLeadInput,
  actorUserId: string,
): Promise<PublicHandymanCrewLead> {
  ensureUuid(input.handymanCrewId, 'handymanCrewId');
  ensureUuid(input.handymanWorkerContextId, 'handymanWorkerContextId');
  ensureUuid(actorUserId, 'actorUserId');

  return withTransaction(async (tx) => {
    const crew = await handymanWorkCrewRepository.lockCrewById(
      tx,
      input.handymanCrewId,
    );
    if (!crew) throw handymanCrewNotFoundError();
    await assertRealm(actorUserId, crew.clientId);
    if (crew.status !== 'ACTIVE') throw handymanCrewInvalidStatusError();

    const workerContext = await eligibleWorkerContext(
      tx,
      input.handymanWorkerContextId,
      crew.handymanProviderContextId,
      crew.clientId,
    );
    const membership = await handymanWorkCrewRepository.findActiveMembership(
      tx,
      crew.id,
      workerContext.id,
    );
    if (!membership) throw handymanCrewMemberNotFoundError();
    const newLeadProfile = await workforceRepository.findById(
      workerContext.workforceProfileId,
    );
    if (!newLeadProfile || newLeadProfile.userId === null) {
      throw handymanCrewLeadInvalidError();
    }

    const currentLead = await handymanWorkCrewRepository.findCurrentLead(
      tx,
      crew.id,
    );
    if (currentLead?.handymanCrewMembershipId === membership.id) {
      throw handymanCrewLeadInvalidError();
    }

    let oldLeadUserId: string | null = null;
    if (currentLead) {
      const oldLeadRes = await tx.query<{ userId: string | null }>(
        `SELECT wp.user_id AS "userId"
           FROM handyman_crew_memberships cm
           JOIN handyman_worker_contexts wc
             ON wc.id = cm.handyman_worker_context_id
           JOIN workforce_profiles wp
             ON wp.id = wc.workforce_profile_id
          WHERE cm.id = $1
          LIMIT 1`,
        [currentLead.handymanCrewMembershipId],
      );
      oldLeadUserId = oldLeadRes.rows[0]?.userId ?? null;
    }

    const lead = await handymanWorkCrewRepository.appendLead(
      tx,
      {
        clientId: crew.clientId,
        handymanCrewId: crew.id,
        handymanCrewMembershipId: membership.id,
        designatedByUserId: actorUserId,
      },
      actorUserId,
    );

    await recordOperationalEvent(
      {
        clientId: crew.clientId,
        eventType: 'HANDYMAN_CREW_LEAD_DESIGNATED',
        entityType: 'HANDYMAN_WORK_CREW',
        entityId: crew.id,
        actorUserId,
        summary: 'Lead Worker designation changed.',
        metadata: {
          crewId: crew.id,
          leadMembershipId: membership.id,
          workerContextId: workerContext.id,
          fromLeadMembershipId: currentLead?.handymanCrewMembershipId ?? null,
        },
      },
      tx,
    );

    // Notify old and new Crew Lead for any active Execution Scope assignments on this crew.
    // If the old Lead had already recorded a terminal decision (TERIMA or TIDAK_BISA)
    // and no active work session is running, rotate the assignment row to a new
    // ACTIVE version (superseding the old row) so the old Lead's immutable decision
    // is preserved in history while the new Lead starts at PENDING.
    const activeAssignmentsRes = await tx.query<{
      assignmentId: string;
      executionScopeId: string;
      providerContextId: string;
      version: number;
      buildingId: string;
      handymanRequestId: string;
      responseStatus: string | null;
      hasActiveSession: boolean;
    }>(
      `SELECT a.id AS "assignmentId",
              a.execution_scope_id AS "executionScopeId",
              a.handyman_provider_context_id AS "providerContextId",
              a.version AS "version",
              s.building_id AS "buildingId",
              s.handyman_request_id AS "handymanRequestId",
              ar.response_status AS "responseStatus",
              EXISTS (
                SELECT 1
                  FROM handyman_work_sessions ws
                 WHERE ws.execution_scope_id = a.execution_scope_id
                   AND ws.status IN ('CHECKED_IN', 'IN_PROGRESS', 'PAUSED', 'MATERIAL_RUN')
              ) AS "hasActiveSession"
         FROM handyman_execution_scope_assignments a
         JOIN handyman_execution_scopes s
           ON s.id = a.execution_scope_id
         LEFT JOIN handyman_assignment_responses ar
           ON ar.assignment_id = a.id
          AND ar.assignment_target_type = 'EXECUTION_SCOPE_ASSIGNMENT'
        WHERE a.client_id = $1
          AND a.handyman_crew_id = $2
          AND a.status = 'ACTIVE'`,
      [crew.clientId, crew.id],
    );

    for (const activeAssign of activeAssignmentsRes.rows) {
      let effectiveAssignmentId = activeAssign.assignmentId;

      if (
        (activeAssign.responseStatus === 'TERIMA' ||
          activeAssign.responseStatus === 'TIDAK_BISA') &&
        !activeAssign.hasActiveSession
      ) {
        const newAssignmentId = randomUUID();
        const { handymanDispatchRepository } = await import(
          '../handyman-dispatch/handyman-dispatch.repository'
        );
        await handymanDispatchRepository.supersedeForAssignment(
          tx,
          activeAssign.assignmentId,
          actorUserId,
          'Crew Lead changed after finalized response',
        );
        await tx.query(
          `UPDATE handyman_execution_scope_assignments
              SET status = 'SUPERSEDED',
                  version = version + 1
            WHERE id = $1
              AND status = 'ACTIVE'
              AND version = $2`,
          [activeAssign.assignmentId, activeAssign.version],
        );
        await assignmentResponseRepository.recordSupersededEvent(
          {
            clientId: crew.clientId,
            buildingId: activeAssign.buildingId,
            assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
            assignmentId: activeAssign.assignmentId,
            handymanRequestId: activeAssign.handymanRequestId,
            executionScopeId: activeAssign.executionScopeId,
            assignedByUserId: actorUserId,
          },
          actorUserId,
          `Superseded by Crew Lead change to ${newLeadProfile.userId}: new assignment ${newAssignmentId}`,
          tx,
        );
        await tx.query(
          `INSERT INTO handyman_execution_scope_assignments (
             id,
             client_id,
             execution_scope_id,
             handyman_provider_context_id,
             handyman_crew_id,
             status,
             assigned_by_user_id,
             supersedes_assignment_id
           )
           VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, $7)`,
          [
            newAssignmentId,
            crew.clientId,
            activeAssign.executionScopeId,
            activeAssign.providerContextId,
            crew.id,
            actorUserId,
            activeAssign.assignmentId,
          ],
        );
        await assignmentResponseRepository.ensurePendingForAssignment(
          {
            clientId: crew.clientId,
            buildingId: activeAssign.buildingId,
            assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
            assignmentId: newAssignmentId,
            handymanRequestId: activeAssign.handymanRequestId,
            executionScopeId: activeAssign.executionScopeId,
            assignedByUserId: actorUserId,
          },
          tx,
        );
        effectiveAssignmentId = newAssignmentId;
      }

      await notifyExecutionScopeCrewLeadSuperseded(
        {
          clientId: crew.clientId,
          buildingId: activeAssign.buildingId,
          handymanRequestId: activeAssign.handymanRequestId,
          executionScopeId: activeAssign.executionScopeId,
          oldAssignmentId: activeAssign.assignmentId,
          newAssignmentId: effectiveAssignmentId,
          oldLeadUserId,
          newLeadUserId: newLeadProfile.userId,
          reason: 'Crew Lead changed',
        },
        tx,
      );

      if (!activeAssign.hasActiveSession) {
        await notifyExecutionScopeCrewLeadAssignedPending(
          {
            clientId: crew.clientId,
            buildingId: activeAssign.buildingId,
            handymanRequestId: activeAssign.handymanRequestId,
            executionScopeId: activeAssign.executionScopeId,
            assignmentId: effectiveAssignmentId,
            crewId: crew.id,
            leadUserId: newLeadProfile.userId,
            leadWorkerContextId: workerContext.id,
          },
          tx,
        );
      }
    }

    return { ...lead, designatedAt: lead.designatedAt.toISOString() };
  });
}

/** Crew lifecycle: activating REQUIRES an exactly-one valid current Lead. */
export async function setHandymanWorkCrewStatus(
  crewId: string,
  status: string,
  actorUserId: string,
): Promise<PublicHandymanWorkCrew> {
  ensureUuid(crewId, 'crewId');
  ensureUuid(actorUserId, 'actorUserId');
  if (!isHandymanCrewStatus(status)) throw handymanCrewInvalidStatusError();

  return withTransaction(async (tx) => {
    const crew = await handymanWorkCrewRepository.lockCrewById(tx, crewId);
    if (!crew) throw handymanCrewNotFoundError();
    await assertRealm(actorUserId, crew.clientId);
    if (crew.status === status) throw handymanCrewInvalidStatusError();

    if (status === 'ACTIVE') {
      const currentLead = await handymanWorkCrewRepository.findCurrentLead(
        tx,
        crew.id,
      );
      if (!currentLead) throw handymanCrewLeadRequiredError();
      const leadMembership = await handymanWorkCrewRepository
        .findMembershipById(tx, currentLead.handymanCrewMembershipId);
      if (!leadMembership || leadMembership.status !== 'ACTIVE') {
        throw handymanCrewLeadRequiredError();
      }
      const leadContext = await handymanWorkerContextRepository.findById(
        tx,
        leadMembership.handymanWorkerContextId,
      );
      if (
        !leadContext ||
        leadContext.status !== 'ACTIVE' ||
        leadContext.handymanProviderContextId !==
          crew.handymanProviderContextId
      ) {
        throw handymanCrewLeadRequiredError();
      }
      const profile = await workforceRepository.findById(
        leadContext.workforceProfileId,
      );
      if (!profile || profile.userId === null) {
        throw handymanCrewLeadRequiredError();
      }
    }

    const projected = await handymanWorkCrewRepository.updateCrewStatus(
      tx,
      crewId,
      status,
    );
    if (!projected) throw handymanCrewNotFoundError();

    await recordOperationalEvent(
      {
        clientId: crew.clientId,
        eventType: 'HANDYMAN_CREW_STATUS_CHANGED',
        entityType: 'HANDYMAN_WORK_CREW',
        entityId: crew.id,
        actorUserId,
        summary: `Handyman work crew status: ${crew.status} → ${status}.`,
        metadata: {
          crewId: crew.id,
          fromStatus: crew.status,
          toStatus: status,
        },
      },
      tx,
    );

    return toPublicCrew(projected);
  });
}

/** Bounded reads (scope: optional actor enforces accessible-Client). */
export async function getHandymanWorkCrew(
  crewId: string,
  actorUserId?: string,
): Promise<{
  crew: PublicHandymanWorkCrew;
  members: PublicHandymanCrewMembership[];
  currentLead: PublicHandymanCrewLead | null;
}> {
  ensureUuid(crewId, 'crewId');
  const crew = await handymanWorkCrewRepository.findCrewById(undefined, crewId);
  if (!crew) throw handymanCrewNotFoundError();
  if (actorUserId !== undefined) {
    ensureUuid(actorUserId, 'actorUserId');
    await assertRealm(actorUserId, crew.clientId);
  }
  const members = await handymanWorkCrewRepository.listMembershipsByCrew(
    undefined,
    crewId,
  );
  const lead = await handymanWorkCrewRepository.findCurrentLead(
    undefined,
    crewId,
  );
  return {
    crew: toPublicCrew(crew),
    members: members.map(toPublicMember),
    currentLead: lead
      ? { ...lead, designatedAt: lead.designatedAt.toISOString() }
      : null,
  };
}

export const handymanWorkCrewService = {
  createHandymanWorkCrew,
  addHandymanCrewMember,
  setHandymanCrewMemberStatus,
  designateHandymanCrewLead,
  setHandymanWorkCrewStatus,
  getHandymanWorkCrew,
};

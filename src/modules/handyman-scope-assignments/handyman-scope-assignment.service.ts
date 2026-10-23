import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanProviderContextRepository,
  handymanWorkerContextRepository,
  handymanWorkCrewRepository,
} from '../handyman-providers';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import { assertHandymanCrewWorkerEligibility } from '../handyman-providers/handyman-worker-eligibility.repository';
import { workforceRepository } from '../workforce';
import { assertExecutionScopeCompetencyEligible } from '../worker-competency-eligibility';
import {
  handymanAssignmentAlreadyActiveError,
  handymanAssignmentActiveSessionBlockError,
  handymanAssignmentContextInactiveError,
  handymanAssignmentContextMismatchError,
  handymanAssignmentIdempotencyConflictError,
  handymanAssignmentLeadInvalidError,
  handymanAssignmentNotFoundError,
  handymanAssignmentScopeNotAuthorizedError,
  handymanAssignmentVersionConflictError,
} from './handyman-scope-assignment.errors';
import {
  handymanScopeAssignmentRepository,
} from './handyman-scope-assignment.repository';
import type {
  AssignHandymanExecutionScopeCrewInput,
  HandymanAssignmentLeadResolution,
  HandymanExecutionScopeAssignmentRecord,
  PublicHandymanExecutionScopeAssignment,
  ReassignHandymanExecutionScopeCrewInput,
} from './handyman-scope-assignment.types';

/**
 * CR-HM-04 Execution Scope Assignment Activation PART B — assignment /
 * reassignment / Lead resolver service (FROZEN activation governance
 * §1–§7).
 *
 * Authority: CR-HM-04 owns provider/crew/Lead/assignment/history;
 * CR-HM-06 owns the Execution Scope (consumed read-only, locked for
 * the write boundary); CR-HM-07 consumes the bounded resolver only.
 * Caller supplies ONLY executionScopeId/providerContextId/crewId;
 * client/status/Lead/userId/timestamps/supersession are server-derived
 * (smuggled keys never trusted). NO scheduling/arrival/QR/geofence/
 * work-session/attendance/payment/BAST/FM runtime exists here.
 */

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw new Error(`HANDYMAN_ES_ASSIGNMENT_INVALID_UUID:${field}`);
  }
  return raw;
}

function ensureReason(value: string | undefined): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length < 1 || raw.length > 1000) {
    throw handymanAssignmentIdempotencyConflictError();
  }
  return raw;
}

function ensureKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim();
  if (raw.length < 8 || raw.length > 128) {
    throw new Error('HANDYMAN_ES_ASSIGNMENT_INVALID_KEY');
  }
  return raw;
}

function toPublic(
  record: HandymanExecutionScopeAssignmentRecord,
): PublicHandymanExecutionScopeAssignment {
  return {
    ...record,
    assignedAt: record.assignedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03A — competency gate.
 *
 * Runs INSIDE the assignment transaction, after the existing eligibility chain
 * has validated provider/crew/Lead/placement, and before any row is written.
 * The decision itself lives in `worker-competency-eligibility` (one evaluator
 * shared with the read API) so the preflight answer and the enforcement verdict
 * can never disagree.
 *
 * Backward compatibility: a job type with no ACTIVE competency requirement
 * returns immediately (`requirementsConfigured: false`) and the assignment
 * proceeds exactly as before this CR. Certifications are never required for all
 * workers — only where a Client configured one.
 *
 * There is no bypass: `assignHandymanExecutionScopeCrew` and
 * `reassignHandymanExecutionScopeCrew` are the only writers of
 * `handyman_execution_scope_assignments`, and dispatch release requires an
 * ACTIVE assignment row, so it cannot be used as an alternative entry point.
 */
async function assertCompetencyEligible(
  tx: PoolClient,
  input: { executionScopeId: string; clientId: string; crewId: string },
): Promise<{ requirementCount: number; mandatoryRequirementCount: number }> {
  const summary = await assertExecutionScopeCompetencyEligible(tx, input);
  return {
    requirementCount: summary.requirementCount,
    mandatoryRequirementCount: summary.mandatoryRequirementCount,
  };
}

/** Locked scope-row precondition (target boundary). */
async function requireAssignableScope(
  tx: PoolClient,
  executionScopeId: string,
): Promise<{ id: string; clientId: string; status: string; buildingId: string }> {
  const scope = await handymanScopeAssignmentRepository.lockScopeById(
    tx,
    executionScopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (scope.status !== 'AUTHORIZED') {
    throw handymanAssignmentScopeNotAuthorizedError();
  }
  return scope;
}

type ValidatedTarget = {
  clientId: string;
  providerContextId: string;
  crewId: string;
  leadWorkerContextId: string;
  leadUserId: string;
};

/**
 * Eligibility (§1): provider context + crew exist and are ACTIVE; the
 * whole chain stays in the scope's Client; crew belongs to the
 * provider context; the current CR-HM-04 Lead is valid (ACTIVE
 * membership, ACTIVE worker context under the same provider/client,
 * non-NULL workforce userId). Failure modes never fabricate an actor.
 * `executor` may be omitted for pool-level read-only composition
 * (resolver path).
 */
async function validateTarget(
  executor: Pick<PoolClient, 'query'> | undefined,
  input: { providerContextId: string; crewId: string },
  clientId: string,
  buildingId: string,
): Promise<ValidatedTarget> {
  const providerContext = await handymanProviderContextRepository
    .findById(executor, input.providerContextId);
  if (!providerContext) throw handymanAssignmentContextInactiveError();
  if (providerContext.status !== 'ACTIVE') {
    throw handymanAssignmentContextInactiveError();
  }
  if (providerContext.clientId !== clientId) {
    throw handymanAssignmentContextMismatchError();
  }
  const crew = await handymanWorkCrewRepository.findCrewById(
    executor,
    input.crewId,
  );
  if (!crew) throw handymanAssignmentContextInactiveError();
  if (crew.status !== 'ACTIVE') {
    throw handymanAssignmentContextInactiveError();
  }
  if (crew.clientId !== clientId) {
    throw handymanAssignmentContextMismatchError();
  }
  if (crew.handymanProviderContextId !== providerContext.id) {
    throw handymanAssignmentContextMismatchError();
  }

  const lead = await handymanWorkCrewRepository.findCurrentLead(
    executor,
    crew.id,
  );
  if (!lead) throw handymanAssignmentLeadInvalidError();
  const memberships = await handymanWorkCrewRepository
    .listMembershipsByCrew(executor, crew.id);
  const membership = memberships.find(
    (m) => m.id === lead.handymanCrewMembershipId,
  );
  if (!membership || membership.status !== 'ACTIVE') {
    throw handymanAssignmentLeadInvalidError();
  }
  const workerContext = await handymanWorkerContextRepository.findById(
    executor,
    membership.handymanWorkerContextId,
  );
  if (
    !workerContext ||
    workerContext.status !== 'ACTIVE' ||
    workerContext.handymanProviderContextId !== providerContext.id ||
    workerContext.clientId !== clientId
  ) {
    throw handymanAssignmentLeadInvalidError();
  }
  const profile = await workforceRepository.findById(
    workerContext.workforceProfileId,
  );
  if (!profile || profile.userId === null) {
    throw handymanAssignmentLeadInvalidError();
  }
  await assertHandymanCrewWorkerEligibility(executor, {clientId, buildingId, crewId: crew.id});
  return {
    clientId,
    providerContextId: providerContext.id,
    crewId: crew.id,
    leadWorkerContextId: workerContext.id,
    leadUserId: profile.userId,
  };
}

async function journal(
  tx: PoolClient,
  assignment: HandymanExecutionScopeAssignmentRecord,
  eventType: string,
  summary: string,
  competency?: { requirementCount: number; mandatoryRequirementCount: number },
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: assignment.clientId,
      eventType,
      entityType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
      entityId: assignment.id,
      actorUserId: assignment.assignedByUserId,
      summary,
      metadata: {
        assignmentId: assignment.id,
        executionScopeId: assignment.executionScopeId,
        handymanProviderContextId: assignment.handymanProviderContextId,
        handymanCrewId: assignment.handymanCrewId,
        status: assignment.status,
        supersedesAssignmentId: assignment.supersedesAssignmentId,
        // PART 03A — proof that the competency gate ran, including the
        // "no requirement configured" case (0/0). A historical assignment can
        // therefore always be explained without re-deriving old catalog state.
        competency: competency ?? null,
      },
    },
    tx,
  );
}

/**
 * First assignment for a scope: one ACTIVE row, atomically (boundary
 * lock serializes per scope). An existing ACTIVE assignment is a
 * CONFLICT — never silently replaced (reassign instead).
 */
export async function assignHandymanExecutionScopeCrew(
  input: AssignHandymanExecutionScopeCrewInput,
  actorUserId: string,
): Promise<PublicHandymanExecutionScopeAssignment> {
  const executionScopeId = ensureUuid(
    input.executionScopeId,
    'executionScopeId',
  );
  const providerContextId = ensureUuid(
    input.providerContextId,
    'providerContextId',
  );
  const crewId = ensureUuid(input.crewId, 'crewId');
  ensureUuid(actorUserId, 'actorUserId');
  const idempotencyKey = ensureKey(input.idempotencyKey);

  return withTransaction(async (tx) => {
    const scope = await requireAssignableScope(tx, executionScopeId);
    // CR-HM-SEC-01 PART 03A — write authorization: the scope row carries
    // the authoritative server-derived building_id; per BE-02G the write
    // requires the actor's explicit ACTIVE assignment to that exact
    // Building (no same-Client shortcut).
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
    });
    const existing =
      await handymanScopeAssignmentRepository.lockActiveAssignmentByScope(
        tx,
        executionScopeId,
      );
    if (existing) throw handymanAssignmentAlreadyActiveError();
    const target = await validateTarget(
      tx,
      { providerContextId, crewId },
      scope.clientId,
      scope.buildingId,
    );
    // PART 03A — competency gate (blocking gaps → 409, nothing written).
    const competency = await assertCompetencyEligible(tx, {
      executionScopeId,
      clientId: scope.clientId,
      crewId: target.crewId,
    });
    const record = await handymanScopeAssignmentRepository
      .insertAssignment(tx, {
        clientId: scope.clientId,
        executionScopeId,
        handymanProviderContextId: target.providerContextId,
        handymanCrewId: target.crewId,
        status: 'ACTIVE',
        assignedByUserId: actorUserId,
        supersedesAssignmentId: null,
      });
    await handymanScopeAssignmentRepository.insertAssignmentHistory(tx, {
      clientId: scope.clientId,
      assignmentId: record.id,
      executionScopeId,
      fromProviderContextId: null,
      fromCrewId: null,
      toProviderContextId: target.providerContextId,
      toCrewId: target.crewId,
      action: 'ASSIGNED',
      reason: null,
      expectedVersion: null,
      priorVersion: null,
      actorUserId,
      idempotencyKey,
    });
    await journal(
      tx,
      record,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED',
      `Handyman execution scope crew assignment created (crew ${record.handymanCrewId}).`,
      competency,
    );
    return toPublic(record);
  });
}

/**
 * Atomic reassignment (P0-B hardened): lock current ACTIVE → active-session
 * guard → version check → validate new provider/crew/Lead → supersede old
 * (with version bump) + insert new ACTIVE + append history row + audit
 * events, all in one transaction. Any failure rolls back ALL — old ACTIVE
 * stays untouched, zero partial rows/events. Never a gap, never two ACTIVE.
 * Reassigning to the SAME crew as the current ACTIVE assignment is treated
 * as a no-op (returns the current assignment) — avoids spurious history.
 */
export async function reassignHandymanExecutionScopeCrew(
  input: ReassignHandymanExecutionScopeCrewInput,
  actorUserId: string,
): Promise<PublicHandymanExecutionScopeAssignment> {
  const executionScopeId = ensureUuid(
    input.executionScopeId,
    'executionScopeId',
  );
  const providerContextId = ensureUuid(
    input.providerContextId,
    'providerContextId',
  );
  const crewId = ensureUuid(input.crewId, 'crewId');
  ensureUuid(actorUserId, 'actorUserId');
  const reason = ensureReason(input.reason);
  const expectedVersion = input.expectedVersion;
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw handymanAssignmentVersionConflictError();
  }
  const idempotencyKey = ensureKey(input.idempotencyKey);

  return withTransaction(async (tx) => {
    const scope = await requireAssignableScope(tx, executionScopeId);
    // CR-HM-SEC-01 PART 03A — write authorization.
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
    });

    // P0-B: Active session guard — cannot transfer an in-progress PIC.
    if (
      await handymanScopeAssignmentRepository.checkActiveWorkSession(
        tx,
        executionScopeId,
      )
    ) {
      throw handymanAssignmentActiveSessionBlockError();
    }

    const current =
      await handymanScopeAssignmentRepository.lockActiveAssignmentByScope(
        tx,
        executionScopeId,
      );
    if (!current) throw handymanAssignmentNotFoundError();
    if (current.version !== expectedVersion) {
      throw handymanAssignmentVersionConflictError();
    }

    // Same crew — no-op replay with same version returns current record.
    if (
      current.handymanProviderContextId === providerContextId &&
      current.handymanCrewId === crewId
    ) {
      return toPublic(current);
    }

    const target = await validateTarget(
      tx,
      { providerContextId, crewId },
      scope.clientId,
      scope.buildingId,
    );
    // PART 03A — the SAME gate applies to reassignment. A crew that cannot take
    // the job type initially cannot take it by transfer either, and the check
    // runs before the current ACTIVE row is superseded, so a rejected
    // reassignment leaves the existing assignment untouched.
    const competency = await assertCompetencyEligible(tx, {
      executionScopeId,
      clientId: scope.clientId,
      crewId: target.crewId,
    });
    // Supersede any RELEASED dispatch release tied to the current ACTIVE
    // assignment BEFORE we flip the assignment to SUPERSEDED — the
    // dispatch-release guard requires the referenced assignment to be
    // ACTIVE at write time, and supersedeForAssignment only targets
    // RELEASED rows (IN_PROGRESS is forbidden by trigger). This ensures
    // the former PIC loses mutation authority and MY_JOBS stops
    // surfacing the work order as actionable after reassignment.
    const { handymanDispatchRepository } = await import(
      '../handyman-dispatch/handyman-dispatch.repository'
    );
    await handymanDispatchRepository.supersedeForAssignment(
      tx,
      current.id,
      actorUserId,
      `Assignment reassigned: ${reason}`,
    );

    const superseded = await handymanScopeAssignmentRepository
      .supersedeAssignment(tx, current.id, expectedVersion);
    if (!superseded) throw handymanAssignmentVersionConflictError();

    await journal(
      tx,
      superseded,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_SUPERSEDED',
      `Handyman execution scope crew assignment superseded: ${reason}.`,
    );
    await handymanScopeAssignmentRepository.insertAssignmentHistory(tx, {
      clientId: scope.clientId,
      assignmentId: superseded.id,
      executionScopeId,
      fromProviderContextId: current.handymanProviderContextId,
      fromCrewId: current.handymanCrewId,
      toProviderContextId: target.providerContextId,
      toCrewId: target.crewId,
      action: 'REASSIGNED',
      reason,
      expectedVersion,
      priorVersion: current.version,
      actorUserId,
      idempotencyKey,
    });
    const record = await handymanScopeAssignmentRepository
      .insertAssignment(tx, {
        clientId: scope.clientId,
        executionScopeId,
        handymanProviderContextId: target.providerContextId,
        handymanCrewId: target.crewId,
        status: 'ACTIVE',
        assignedByUserId: actorUserId,
        supersedesAssignmentId: current.id,
      });
    await journal(
      tx,
      record,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED',
      `Handyman execution scope crew reassignment created (crew ${record.handymanCrewId}).`,
      competency,
    );
    return toPublic(record);
  });
}

/** Bounded current-assignment read (internal + PART C seam). */
export async function getHandymanExecutionScopeAssignment(
  executionScopeId: string,
  actorUserId: string,
): Promise<PublicHandymanExecutionScopeAssignment | null> {
  ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    executionScopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  // CR-HM-SEC-01 PART 03B — read authorization: the scope row carries
  // the authoritative server-derived building_id; per BE-02G the read
  // requires the actor's explicit ACTIVE assignment to that exact
  // Building (no same-Client shortcut; no existence/content leak).
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  const current = await handymanScopeAssignmentRepository
    .findActiveAssignmentByScope(undefined, executionScopeId);
  return current ? toPublic(current) : null;
}

/**
 * FROZEN §5 consumer contract (CR-HM-07): dynamically resolve the
 * authoritative field actor. scopeId → ACTIVE assignment → crew →
 * current CR-HM-04 Lead → ACTIVE worker context → non-NULL userId.
 * NO Lead snapshot is read from the assignment; caller worker/crew
 * ids are never trusted; invalid/missing Lead fails closed.
 * Returns null when no ACTIVE assignment exists (bounded "none").
 */
export async function resolveHandymanAssignmentLead(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanAssignmentLeadResolution | null> {
  ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    executionScopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  // CR-HM-SEC-01 PART 03B — read authorization: the scope row carries
  // the authoritative server-derived building_id; per BE-02G the read
  // requires the actor's explicit ACTIVE assignment to that exact
  // Building (no same-Client shortcut; no existence/content leak).
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  const current = await handymanScopeAssignmentRepository
    .findActiveAssignmentByScope(undefined, executionScopeId);
  if (!current) return null;
  const target = await validateTarget(
    undefined,
    {
      providerContextId: current.handymanProviderContextId,
      crewId: current.handymanCrewId,
    },
    current.clientId,
    scope.buildingId,
  );
  return {
    assignmentId: current.id,
    crewId: target.crewId,
    leadWorkerContextId: target.leadWorkerContextId,
    leadUserId: target.leadUserId,
  };
}

export const handymanScopeAssignmentService = {
  assignHandymanExecutionScopeCrew,
  reassignHandymanExecutionScopeCrew,
  getHandymanExecutionScopeAssignment,
  resolveHandymanAssignmentLead,
};

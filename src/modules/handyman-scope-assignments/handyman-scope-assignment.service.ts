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
import {
  evaluateExecutionScopeCompetency,
  recordAssignmentCompetencyDecision,
  type ExecutionScopeCompetencyDecision,
} from '../worker-competency-eligibility';
import {
  assignmentDeclineReasonForbiddenOnAcceptError,
  assignmentDeclineReasonRequiredError,
  assertAssignmentResponseWindowOpen,
  assertClientKeyAvailableForAssignment,
  assignmentResponseRepository,
  handymanAssignmentResponseConflictError,
  normalizeAssignmentResponseClientKey,
  handymanAssignmentResponseForbiddenError,
  handymanAssignmentResponseLateError,
  handymanAssignmentResponseSupersededError,
  isAssignableResponseDecision,
  notifyExecutionScopeAssignmentAccepted,
  notifyExecutionScopeAssignmentDeclined,
  notifyExecutionScopeCrewLeadAssignedPending,
  notifyExecutionScopeCrewLeadSuperseded,
  toPublicAssignmentResponseEvent,
  type HandymanAssignmentResponseRecord,
} from '../assignment-responses';
import { AppError } from '../../shared/errors';
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
  HandymanExecutionScopeAssignmentResponseHistoryView,
  HandymanExecutionScopeAssignmentResponseView,
  PublicHandymanExecutionScopeAssignment,
  ReassignHandymanExecutionScopeCrewInput,
  RespondToHandymanExecutionScopeAssignmentInput,
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
  response?: HandymanAssignmentResponseRecord | null,
): PublicHandymanExecutionScopeAssignment {
  const responseStatus = response?.responseStatus ?? 'PENDING';
  return {
    ...record,
    assignedAt: record.assignedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    responseStatus,
    respondedByUserId: response?.respondedByUserId ?? null,
    respondedByWorkerId: response?.respondedByWorkerId ?? null,
    respondedAt: response?.respondedAt
      ? response.respondedAt.toISOString()
      : null,
    declineReason: response?.declineReason ?? null,
    responseNotes: response?.responseNotes ?? null,
    reassignmentRequired:
      record.status === 'ACTIVE' && responseStatus === 'TIDAK_BISA',
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
): Promise<{
  summary: { requirementCount: number; mandatoryRequirementCount: number };
  decision: ExecutionScopeCompetencyDecision;
}> {
  const decision = await evaluateExecutionScopeCompetency(tx, input);
  return {
    summary: {
      requirementCount: decision.summary.requirementCount,
      mandatoryRequirementCount: decision.summary.mandatoryRequirementCount,
    },
    decision,
  };
}

/**
 * CR-HM-WORKER-COMPETENCY-01 PART 03B1 — persists the decision history.
 *
 * Called with the SAME `tx` as the assignment insert, after the assignment row
 * exists (the ledger references it) and before commit. A rolled-back assignment
 * therefore rolls back its decision rows too, and a committed assignment always
 * carries the exact evaluation that authorised it.
 *
 * The evaluated set is the one the gate just produced — never a re-evaluation,
 * so the ledger cannot drift from the enforced verdict.
 */
async function persistCompetencyDecision(
  tx: PoolClient,
  input: {
    decision: ExecutionScopeCompetencyDecision;
    clientId: string;
    executionScopeId: string;
    assignmentId: string;
    crewId: string;
    action: 'ASSIGNED' | 'REASSIGNED';
  },
): Promise<void> {
  await recordAssignmentCompetencyDecision(tx, {
    clientId: input.clientId,
    executionScopeId: input.executionScopeId,
    assignmentId: input.assignmentId,
    crewId: input.crewId,
    action: input.action,
    serviceCatalogId: input.decision.serviceCatalogId,
    evaluations: input.decision.evaluations,
  });
}

/** Locked scope-row precondition (target boundary). */
async function requireAssignableScope(
  tx: PoolClient,
  executionScopeId: string,
): Promise<{
  id: string;
  clientId: string;
  handymanRequestId: string;
  status: string;
  buildingId: string;
}> {
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
    const { summary: competency, decision } = await assertCompetencyEligible(
      tx,
      {
        executionScopeId,
        clientId: scope.clientId,
        crewId: target.crewId,
      },
    );
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
    // PART 03B1 — decision history, same transaction as the assignment.
    await persistCompetencyDecision(tx, {
      decision,
      clientId: scope.clientId,
      executionScopeId,
      assignmentId: record.id,
      crewId: target.crewId,
      action: 'ASSIGNED',
    });
    await journal(
      tx,
      record,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED',
      `Handyman execution scope crew assignment created (crew ${record.handymanCrewId}).`,
      competency,
    );
    const pendingResponse =
      await assignmentResponseRepository.ensurePendingForAssignment(
        {
          assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
          assignmentId: record.id,
          clientId: scope.clientId,
          buildingId: scope.buildingId,
          handymanRequestId: scope.handymanRequestId,
          executionScopeId: scope.id,
          assignedByUserId: actorUserId,
          assignedAt: record.assignedAt,
        },
        tx,
      );
    await notifyExecutionScopeCrewLeadAssignedPending(
      {
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        handymanRequestId: scope.handymanRequestId,
        executionScopeId: scope.id,
        assignmentId: record.id,
        crewId: target.crewId,
        leadUserId: target.leadUserId,
        leadWorkerContextId: target.leadWorkerContextId,
      },
      tx,
    );
    return toPublic(record, pendingResponse);
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

    // Same crew — no-op replay with same version returns current record when still PENDING.
    const currentResponse =
      await assignmentResponseRepository.findByAssignmentId(
        current.id,
        tx,
      );
    if (
      current.handymanProviderContextId === providerContextId &&
      current.handymanCrewId === crewId &&
      (!currentResponse || currentResponse.responseStatus === 'PENDING')
    ) {
      return toPublic(current, currentResponse);
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
    const { summary: competency, decision } = await assertCompetencyEligible(
      tx,
      {
        executionScopeId,
        clientId: scope.clientId,
        crewId: target.crewId,
      },
    );
    // CR-HM-ASSIGNMENT-RESPONSE-01 PART 02B — the crew lead who owned the
    // superseded assignment, so the superseded IN_APP notification reaches the
    // same person even after the lead changes.
    const oldLeadRes = await tx.query<{ userId: string | null }>(
      `SELECT wp.user_id AS "userId"
         FROM handyman_crew_leads cl
         JOIN handyman_crew_memberships cm
           ON cm.id = cl.handyman_crew_membership_id
         JOIN handyman_worker_contexts wc
           ON wc.id = cm.handyman_worker_context_id
         JOIN workforce_profiles wp
           ON wp.id = wc.workforce_profile_id
        WHERE cl.handyman_crew_id = $1
        ORDER BY cl.lead_seq DESC
        LIMIT 1`,
      [current.handymanCrewId],
    );
    const oldLeadUserId = oldLeadRes.rows[0]?.userId ?? null;

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
    // PART 03B1 — decision history for the reassignment, same transaction.
    await persistCompetencyDecision(tx, {
      decision,
      clientId: scope.clientId,
      executionScopeId,
      assignmentId: record.id,
      crewId: target.crewId,
      action: 'REASSIGNED',
    });
    await journal(
      tx,
      record,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED',
      `Handyman execution scope crew reassignment created (crew ${record.handymanCrewId}).`,
      competency,
    );

    await assignmentResponseRepository.recordSupersededEvent(
      {
        assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
        assignmentId: current.id,
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        handymanRequestId: scope.handymanRequestId,
        executionScopeId: scope.id,
        assignedByUserId: current.assignedByUserId,
        assignedAt: current.assignedAt,
      },
      actorUserId,
      reason,
      tx,
    );
    const pendingResponse =
      await assignmentResponseRepository.ensurePendingForAssignment(
        {
          assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
          assignmentId: record.id,
          clientId: scope.clientId,
          buildingId: scope.buildingId,
          handymanRequestId: scope.handymanRequestId,
          executionScopeId: scope.id,
          assignedByUserId: actorUserId,
          assignedAt: record.assignedAt,
        },
        tx,
      );
    await notifyExecutionScopeCrewLeadSuperseded(
      {
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        handymanRequestId: scope.handymanRequestId,
        executionScopeId: scope.id,
        oldAssignmentId: current.id,
        newAssignmentId: record.id,
        oldLeadUserId,
        newLeadUserId: target.leadUserId,
        reason,
      },
      tx,
    );
    await notifyExecutionScopeCrewLeadAssignedPending(
      {
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        handymanRequestId: scope.handymanRequestId,
        executionScopeId: scope.id,
        assignmentId: record.id,
        crewId: target.crewId,
        leadUserId: target.leadUserId,
        leadWorkerContextId: target.leadWorkerContextId,
      },
      tx,
    );
    return toPublic(record, pendingResponse);
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
  if (!current) return null;
  const response = await assignmentResponseRepository.findByAssignmentId(
    current.id,
  );
  return toPublic(current, response);
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

/**
 * CR-HM-ASSIGNMENT-RESPONSE-01 PART 02B:
 * Allows the authoritative active Crew Lead (and ONLY the current Crew Lead —
 * never Helpers, former Leads, or Operations users) to respond `TERIMA` or
 * `TIDAK_BISA` to an Execution Scope Crew assignment.
 *
 * - `TIDAK_BISA` requires a mandatory `declineReason` (1..1000 chars), sets
 *   `reassignmentRequired = true`, and notifies Operations (`IN_APP`) without
 *   cancelling the Tenant request or Execution Scope.
 * - Duplicate identical responses are idempotent no-ops (`idempotentReplay: true`).
 * - Conflicting responses (`TERIMA <-> TIDAK_BISA` or modified declineReason)
 *   are rejected with `409 HANDYMAN_ASSIGNMENT_RESPONSE_CONFLICT`.
 * - Superseded assignments are rejected with `409 HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED`.
 * - Late responses after a work session has already started are rejected with
 *   `409 HANDYMAN_ASSIGNMENT_RESPONSE_LATE`.
 */
export async function respondToHandymanExecutionScopeAssignment(
  input: RespondToHandymanExecutionScopeAssignmentInput,
  actorUserId: string,
): Promise<HandymanExecutionScopeAssignmentResponseView> {
  const executionScopeId = ensureUuid(
    input.executionScopeId,
    'executionScopeId',
  );
  const assignmentId = ensureUuid(input.assignmentId, 'assignmentId');
  ensureUuid(actorUserId, 'actorUserId');

  if (!isAssignableResponseDecision(input.responseStatus)) {
    throw AppError.validation(
      "responseStatus must be either 'TERIMA' or 'TIDAK_BISA'.",
    );
  }

  const rawDeclineReason =
    typeof input.declineReason === 'string' ? input.declineReason.trim() : '';
  if (input.responseStatus === 'TIDAK_BISA') {
    if (rawDeclineReason.length === 0 || rawDeclineReason.length > 1000) {
      throw assignmentDeclineReasonRequiredError();
    }
  } else if (rawDeclineReason.length > 0) {
    throw assignmentDeclineReasonForbiddenOnAcceptError();
  }
  const normalizedDeclineReason =
    input.responseStatus === 'TIDAK_BISA' ? rawDeclineReason : null;

  const rawNotes =
    typeof input.notes === 'string' ? input.notes.trim() : '';
  if (rawNotes.length > 2000) {
    throw AppError.validation('notes must not exceed 2000 characters.');
  }
  const normalizedNotes = rawNotes.length > 0 ? rawNotes : null;
  const clientKey = normalizeAssignmentResponseClientKey(input.idempotencyKey);

  return withTransaction(async (tx) => {
    const scope = await handymanScopeAssignmentRepository.lockScopeById(
      tx,
      executionScopeId,
    );
    if (!scope) throw handymanExecutionScopeNotFoundError();

    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
    });

    const assignment =
      await handymanScopeAssignmentRepository.lockAssignmentByIdAndScope(
        tx,
        assignmentId,
        executionScopeId,
      );
    if (!assignment) throw handymanAssignmentNotFoundError();

    if (assignment.status !== 'ACTIVE') {
      // Check if actor was ever a lead on this crew; if not, 403 forbidden;
      // if they were, 409 superseded.
      const wasLeadRes = await tx.query(
        `SELECT 1
           FROM handyman_crew_leads cl
           JOIN handyman_crew_memberships cm
             ON cm.id = cl.handyman_crew_membership_id
           JOIN handyman_worker_contexts wc
             ON wc.id = cm.handyman_worker_context_id
           JOIN workforce_profiles wp
             ON wp.id = wc.workforce_profile_id
          WHERE cl.handyman_crew_id = $1
            AND wp.user_id = $2
          LIMIT 1`,
        [assignment.handymanCrewId, actorUserId],
      );
      if ((wasLeadRes.rowCount ?? 0) === 0) {
        throw handymanAssignmentResponseForbiddenError();
      }
      throw handymanAssignmentResponseSupersededError();
    }

    const target = await validateTarget(
      tx,
      {
        providerContextId: assignment.handymanProviderContextId,
        crewId: assignment.handymanCrewId,
      },
      scope.clientId,
      scope.buildingId,
    );
    if (target.leadUserId !== actorUserId) {
      throw handymanAssignmentResponseForbiddenError();
    }

    await assignmentResponseRepository.ensurePendingForAssignment(
      {
        assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
        assignmentId: assignment.id,
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        handymanRequestId: scope.handymanRequestId,
        executionScopeId: scope.id,
        assignedByUserId: assignment.assignedByUserId,
        assignedAt: assignment.assignedAt,
      },
      tx,
    );
    const existing =
      await assignmentResponseRepository.findByAssignmentIdForUpdate(
        assignment.id,
        tx,
      );
    if (!existing) {
      throw handymanAssignmentNotFoundError();
    }

    // Idempotent replay check before late/conflict check when status matches
    if (existing.responseStatus === input.responseStatus) {
      const sameDecline =
        (existing.declineReason ?? null) === normalizedDeclineReason;
      const sameNotes = (existing.responseNotes ?? null) === normalizedNotes;
      if (sameDecline && sameNotes) {
        return {
          assignmentId: assignment.id,
          executionScopeId: scope.id,
          handymanRequestId: scope.handymanRequestId,
          crewId: target.crewId,
          providerContextId: target.providerContextId,
          status: assignment.status,
          leadWorkerContextId: target.leadWorkerContextId,
          leadUserId: target.leadUserId,
          responseStatus: existing.responseStatus,
          respondedByUserId: existing.respondedByUserId,
          respondedByWorkerId: existing.respondedByWorkerId,
          respondedAt: existing.respondedAt
            ? existing.respondedAt.toISOString()
            : null,
          declineReason: existing.declineReason,
          responseNotes: existing.responseNotes,
          reassignmentRequired: existing.responseStatus === 'TIDAK_BISA',
          acknowledgedAt:
            existing.responseStatus === 'TERIMA' && existing.respondedAt
              ? existing.respondedAt.toISOString()
              : null,
          idempotentReplay: true,
        };
      }
      throw handymanAssignmentResponseConflictError();
    }

    if (existing.responseStatus !== 'PENDING') {
      throw handymanAssignmentResponseConflictError();
    }

    // Late response guard: cannot respond after a work session has already
    // been checked in / started for this assignment or scope is no longer AUTHORIZED.
    if (scope.status !== 'AUTHORIZED') {
      throw handymanAssignmentResponseLateError();
    }
    const sessionRes = await tx.query(
      `SELECT 1
         FROM handyman_work_sessions
        WHERE execution_scope_id = $1
          AND assignment_id = $2
        LIMIT 1`,
      [executionScopeId, assignment.id],
    );
    if ((sessionRes.rowCount ?? 0) > 0) {
      throw handymanAssignmentResponseLateError();
    }

    // CR-HM-FIELD-OPS-ACK-01 PART 01 — concurrent-device key guard and the
    // authoritative appointment-window expiry guard. Both run after the
    // identical-decision replay check, inside the SAME locked transaction.
    await assertClientKeyAvailableForAssignment(
      { actorUserId, assignmentId: assignment.id, clientIdempotencyKey: clientKey },
      tx,
    );
    await assertAssignmentResponseWindowOpen(
      {
        assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
        assignmentId: assignment.id,
      },
      tx,
    );

    const updated = await assignmentResponseRepository.recordDecision(
      {
        assignmentId: assignment.id,
        decision: input.responseStatus,
        actorUserId,
        actorWorkerId: target.leadWorkerContextId,
        declineReason: normalizedDeclineReason,
        notes: normalizedNotes,
        clientIdempotencyKey: clientKey,
      },
      tx,
    );

    // Explicit acknowledgment / audit trail. Append-only operational event on
    // the shared BE-07 store; the notification producer stays the ONLY writer
    // of notifications (PR #58 preserved).
    await recordOperationalEvent(
      {
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        entityType: 'HANDYMAN_ASSIGNMENT_RESPONSE',
        entityId: assignment.id,
        actorUserId,
        eventType:
          input.responseStatus === 'TERIMA'
            ? 'HANDYMAN_ASSIGNMENT_ACKNOWLEDGED'
            : 'HANDYMAN_ASSIGNMENT_DECLINED',
        summary:
          input.responseStatus === 'TERIMA'
            ? 'Execution scope crew assignment acknowledged (TERIMA)'
            : 'Execution scope crew assignment declined (TIDAK_BISA)',
        metadata: {
          assignmentTargetType: 'EXECUTION_SCOPE_ASSIGNMENT',
          assignmentId: assignment.id,
          executionScopeId: scope.id,
          handymanRequestId: scope.handymanRequestId,
          crewId: target.crewId,
          responseStatus: input.responseStatus,
          actorWorkerId: target.leadWorkerContextId,
          declineReason: normalizedDeclineReason,
          clientKeyProvided: clientKey !== null,
          respondedAt: updated.respondedAt?.toISOString() ?? null,
        },
      },
      tx,
    );

    if (input.responseStatus === 'TERIMA') {
      await notifyExecutionScopeAssignmentAccepted(
        {
          clientId: scope.clientId,
          buildingId: scope.buildingId,
          handymanRequestId: scope.handymanRequestId,
          executionScopeId: scope.id,
          assignmentId: assignment.id,
          crewId: target.crewId,
          assignedByUserId: assignment.assignedByUserId,
          respondedByUserId: actorUserId,
          respondedByWorkerId: target.leadWorkerContextId,
          respondedAt: updated.respondedAt!,
        },
        tx,
      );
    } else {
      await notifyExecutionScopeAssignmentDeclined(
        {
          clientId: scope.clientId,
          buildingId: scope.buildingId,
          handymanRequestId: scope.handymanRequestId,
          executionScopeId: scope.id,
          assignmentId: assignment.id,
          crewId: target.crewId,
          assignedByUserId: assignment.assignedByUserId,
          respondedByUserId: actorUserId,
          respondedByWorkerId: target.leadWorkerContextId,
          respondedAt: updated.respondedAt!,
          declineReason: normalizedDeclineReason!,
        },
        tx,
      );
    }

    return {
      assignmentId: assignment.id,
      executionScopeId: scope.id,
      handymanRequestId: scope.handymanRequestId,
      crewId: target.crewId,
      providerContextId: target.providerContextId,
      status: assignment.status,
      leadWorkerContextId: target.leadWorkerContextId,
      leadUserId: target.leadUserId,
      responseStatus: updated.responseStatus,
      respondedByUserId: updated.respondedByUserId,
      respondedByWorkerId: updated.respondedByWorkerId,
      respondedAt: updated.respondedAt
        ? updated.respondedAt.toISOString()
        : null,
      declineReason: updated.declineReason,
      responseNotes: updated.responseNotes,
      reassignmentRequired: updated.responseStatus === 'TIDAK_BISA',
      acknowledgedAt:
        updated.responseStatus === 'TERIMA' && updated.respondedAt
          ? updated.respondedAt.toISOString()
          : null,
      idempotentReplay: false,
    };
  });
}

export async function listHandymanExecutionScopeAssignmentResponseHistory(
  executionScopeId: string,
  assignmentId: string,
  actorUserId: string,
): Promise<HandymanExecutionScopeAssignmentResponseHistoryView> {
  ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(assignmentId, 'assignmentId');
  ensureUuid(actorUserId, 'actorUserId');

  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    executionScopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();

  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });

  const assignment =
    await handymanScopeAssignmentRepository.findAssignmentByIdAndScope(
      undefined,
      assignmentId,
      executionScopeId,
    );
  if (!assignment) throw handymanAssignmentNotFoundError();

  const [response, events] = await Promise.all([
    assignmentResponseRepository.findByAssignmentId(assignment.id),
    assignmentResponseRepository.listEventsByAssignmentId(assignment.id),
  ]);

  const responseStatus = response?.responseStatus ?? 'PENDING';
  return {
    assignmentId: assignment.id,
    executionScopeId: scope.id,
    status: assignment.status,
    responseStatus,
    respondedByUserId: response?.respondedByUserId ?? null,
    respondedByWorkerId: response?.respondedByWorkerId ?? null,
    respondedAt: response?.respondedAt
      ? response.respondedAt.toISOString()
      : null,
    declineReason: response?.declineReason ?? null,
    responseNotes: response?.responseNotes ?? null,
    reassignmentRequired:
      assignment.status === 'ACTIVE' && responseStatus === 'TIDAK_BISA',
    acknowledgedAt:
      responseStatus === 'TERIMA' && response?.respondedAt
        ? response.respondedAt.toISOString()
        : null,
    acknowledgedByUserId:
      responseStatus === 'TERIMA' ? (response?.respondedByUserId ?? null) : null,
    events: events.map(toPublicAssignmentResponseEvent),
  };
}

export const handymanScopeAssignmentService = {
  assignHandymanExecutionScopeCrew,
  reassignHandymanExecutionScopeCrew,
  getHandymanExecutionScopeAssignment,
  resolveHandymanAssignmentLead,
  respondToHandymanExecutionScopeAssignment,
  listHandymanExecutionScopeAssignmentResponseHistory,
};

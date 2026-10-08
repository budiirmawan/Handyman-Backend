import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanProviderContextRepository,
  handymanWorkerContextRepository,
  handymanWorkCrewRepository,
} from '../handyman-providers';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import { workforceRepository } from '../workforce';
import {
  handymanAssignmentAlreadyActiveError,
  handymanAssignmentContextInactiveError,
  handymanAssignmentContextMismatchError,
  handymanAssignmentLeadInvalidError,
  handymanAssignmentNotFoundError,
  handymanAssignmentScopeNotAuthorizedError,
} from './handyman-scope-assignment.errors';
import {
  handymanScopeAssignmentRepository,
} from './handyman-scope-assignment.repository';
import type {
  AssignHandymanExecutionScopeCrewInput,
  HandymanAssignmentLeadResolution,
  HandymanExecutionScopeAssignmentRecord,
  PublicHandymanExecutionScopeAssignment,
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

async function assertRealm(
  actorUserId: string,
  clientId: string,
): Promise<void> {
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
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
    await journal(
      tx,
      record,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED',
      `Handyman execution scope crew assignment created (crew ${record.handymanCrewId}).`,
    );
    return toPublic(record);
  });
}

/**
 * Atomic reassignment: lock current ACTIVE → validate the new
 * provider/crew/Lead BEFORE mutating anything → supersede old +
 * insert new ACTIVE (supersession provenance) + audit events, all in
 * one transaction. Any failure rolls back ALL — old ACTIVE stays
 * untouched, zero partial rows/events. Never a gap, never two ACTIVE.
 */
export async function reassignHandymanExecutionScopeCrew(
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
    const current =
      await handymanScopeAssignmentRepository.lockActiveAssignmentByScope(
        tx,
        executionScopeId,
      );
    if (!current) throw handymanAssignmentNotFoundError();
    const target = await validateTarget(
      tx,
      { providerContextId, crewId },
      scope.clientId,
    );
    const superseded = await handymanScopeAssignmentRepository
      .supersedeAssignment(tx, current.id);
    if (!superseded) throw handymanAssignmentNotFoundError();
    await journal(
      tx,
      superseded,
      'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_SUPERSEDED',
      `Handyman execution scope crew assignment superseded by reassignment.`,
    );
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
  await assertRealm(actorUserId, scope.clientId);
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
  await assertRealm(actorUserId, scope.clientId);
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

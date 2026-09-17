import { createHash } from 'node:crypto';
import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { handymanWorkCrewRepository } from '../handyman-work-crews';
import { recordOperationalEvent } from '../operational-events';
import {
  transitionVendorWorkStatus,
  vendorWorkNotFoundError,
  vendorWorkRepository,
} from '../vendor-work';
import {
  transitionWorkOrderStatus,
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import { aggregateVendorWorkPermitReadiness } from '../work-permit-readiness';
import { handymanJobNotAssignedError } from './handyman-job.errors';
import { handymanJobRepository } from './handyman-job.repository';
import { requireEligibleProviderForJobPreauthorized } from './handyman-job.service';
import {
  handymanServiceVisitNotFoundError,
  handymanServiceVisitNotSchedulableError,
} from './handyman-service-visit.errors';
import { handymanServiceVisitRepository } from './handyman-service-visit.repository';
import {
  assessHandymanServiceVisitExecutionReadinessCore,
  type ExecutionReadinessSubreads,
} from './handyman-service-visit.service';
import { resolveFieldActorActiveBindingIds } from './handyman-visit-lead-chain';
import { handymanVisitArrivalRepository } from './handyman-visit-arrival.repository';
import {
  loadFieldJobContext,
  reassertArrivalContextInTx,
  requireArrivalChain,
  type ArrivalChainContext,
} from './handyman-visit-arrival.service';
import { handymanVisitPresenceRepository } from './handyman-visit-presence.repository';
import { evaluateHandymanVisitExecutionPresence } from './handyman-visit-presence.service';
import {
  handymanWorkSessionActorNotLeadError,
  handymanWorkSessionAlreadyOpenError,
  handymanWorkSessionArrivalRequiredError,
  handymanWorkSessionEvidenceInvalidError,
  handymanWorkSessionExecutionNotReadyError,
  handymanWorkSessionExecutionStateInconsistentError,
  handymanWorkSessionExecutionStateInvalidError,
  handymanWorkSessionIdempotencyConflictError,
  handymanWorkSessionIdempotencyKeyRequiredError,
  handymanWorkSessionLeadNotPresentError,
  handymanWorkSessionNotFoundError,
  handymanWorkSessionStateInvalidError,
} from './handyman-work-session.errors';
import {
  handymanWorkSessionRepository,
  type NewHandymanWorkSession,
} from './handyman-work-session.repository';
import type {
  HandymanExecutionStartState,
  HandymanWorkSessionEndResult,
  HandymanWorkSessionRecord,
  HandymanWorkSessionStartResult,
  PublicHandymanWorkSession,
  StartHandymanWorkSessionInput,
} from './handyman-work-session.types';
import type { HandymanServiceVisitRecord } from './handyman-service-visit.types';

/**
 * CR-HM-BE-06 RUN 2 — Handyman work session command authority: the guarded
 * execution start, the replay-safe end, and the Run-3 read model.
 *
 * Governance encoded here:
 * - FIELD AUTHORITY (§4): only the authenticated actor resolving through
 *   the governed chain (user → BE-03C workforce profile → ACTIVE vendor
 *   workforce binding → ACTIVE crew membership → LEAD_WORKER of the visit's
 *   current composition crew) may START. Helpers can never start; no RBAC
 *   role name is hardcoded anywhere (the BE-04 findActiveLead membership is
 *   the lead authority); no assisted-staff start path is invented.
 * - ONE HANDYMAN TRANSACTION (§6 Phase 1): the decisive start operation
 *   locks and revalidates the whole Run-2 visit-path family (verbatim order
 *   via the Run-1 reassertion), locks the BE-15B vendor work row, asserts
 *   the execution-start states (§3.J/K, Case D), re-checks arrival/presence
 *   under the visit lock, opens the session (or converges), and audits —
 *   then commits. The vendor_work / work_order transitions happen
 *   POST-COMMIT through their OWNING services (§6 Phases 2–3): vendor work
 *   first, work order only after vendor work is IN_PROGRESS. The work order
 *   is never ahead of its vendor work; a transient vendor_work=IN_PROGRESS
 *   + WO=ASSIGNED pair is recoverable and every replay converges the seam.
 * - READINESS (§3.I/§11): the BE-05 readiness assessment stays the ONE
 *   semantic authority — consumed through its factored core with
 *   preauthorized subreads (BE-02/BE-15D access-neutral variants of the
 *   identical rule bodies) because the public readiness read is gated on
 *   staff building assignments that external field leads can never hold.
 *   The work-order predicate is the execution-start legality rule (§3.K:
 *   ASSIGNED or IN_PROGRESS) instead of the read model's pre-execution
 *   rule; every other check is consumed unchanged.
 * - REPLAY (§7/§8): converged commands re-run the guarded seam (Cases A/B/C
 *   complete; Case D — WO IN_PROGRESS over vendor work NOT_STARTED — always
 *   fails with the owned inconsistency error and is never normalized). The
 *   seam tolerates worlds that legitimately advanced past the start states
 *   (ON_HOLD/COMPLETED/CANCELLED): a late replay never regresses or forces
 *   a transition; it converges onto the recorded facts.
 * - END (§12/§13): guarded OPEN → CLOSED with server-stamped ended_at and
 *   the real closing actor; replay-safe; history retained (no DELETE). The
 *   end NEVER auto-completes vendor work, work orders, QC, BAST, invoices,
 *   payroll, or settlements. Authorization: the current ACTIVE lead of the
 *   session's immutable start-context crew OR of the visit's current
 *   ACTIVE composition crew (the smallest auditable rule covering
 *   reassignment between start and end); no helper, no foreign actor, no
 *   invented role, no staff path.
 * - EVENTS (§14): HANDYMAN_WORK_SESSION_STARTED/ENDED carry ids, statuses
 *   and timestamps only — no PII, no GPS, no device data, no billing. The
 *   vendor_work / work_order lifecycle events stay owned by BE-15B/BE-08C
 *   and are never duplicated here.
 */

/** Legal execution-start states (§3.J/K). */
const LEGAL_START_VENDOR_WORK_STATUSES: readonly string[] = [
  'NOT_STARTED',
  'IN_PROGRESS',
];
const LEGAL_START_WORK_ORDER_STATUSES: readonly string[] = [
  'ASSIGNED',
  'IN_PROGRESS',
];

/**
 * §11 injection: the SAME BE-05 readiness core with access-neutral subreads
 * of the identical rule authorities + the §3.K execution-start work-order
 * predicate. One semantic authority — no checklist is duplicated here.
 */
const FIELD_START_READINESS_SUBREADS: ExecutionReadinessSubreads = {
  requireProviderEligibility: (jobContext, handymanProviderId) =>
    requireEligibleProviderForJobPreauthorized(jobContext, handymanProviderId),
  resolvePermitReadiness: (vendorWorkId) =>
    aggregateVendorWorkPermitReadiness(vendorWorkId),
  isWorkOrderStartable: (workOrderStatus) =>
    LEGAL_START_WORK_ORDER_STATUSES.includes(workOrderStatus),
};

export function toPublicHandymanWorkSession(
  record: HandymanWorkSessionRecord,
): PublicHandymanWorkSession {
  return {
    id: record.id,
    clientId: record.clientId,
    visitId: record.visitId,
    vendorWorkId: record.vendorWorkId,
    handymanJobAssignmentId: record.handymanJobAssignmentId,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    startedByUserId: record.startedByUserId,
    endedAt: record.endedAt ? record.endedAt.toISOString() : null,
    endedByUserId: record.endedByUserId,
    occurredAt: record.occurredAt ? record.occurredAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/**
 * Business-fact fingerprint (the Run-1 convention): the visit identity plus
 * the client-claimed evidence timestamp. The actor is deliberately NOT a
 * fact — same key + same facts from the original starter converges; same
 * key + different facts is a 409.
 */
function computeStartFingerprint(
  visitId: string,
  occurredAt: Date | null,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        handymanServiceVisitId: visitId,
        occurredAt: occurredAt ? occurredAt.toISOString() : null,
      }),
    )
    .digest('hex');
}

/**
 * §3.J/K + §7 Case D, asserted on LOCKED rows in the decisive transaction.
 * The work order may never claim progress its vendor work does not have.
 */
function assertExecutionStartStates(
  vendorWorkStatus: string,
  workOrderStatus: string,
): void {
  if (
    vendorWorkStatus === 'NOT_STARTED' &&
    workOrderStatus === 'IN_PROGRESS'
  ) {
    // Case D — owned inconsistency, never silently normalized (§7).
    throw handymanWorkSessionExecutionStateInconsistentError();
  }
  if (!LEGAL_START_VENDOR_WORK_STATUSES.includes(vendorWorkStatus)) {
    throw handymanWorkSessionExecutionStateInvalidError(
      `Vendor work status ${vendorWorkStatus} does not permit starting execution.`,
    );
  }
  if (!LEGAL_START_WORK_ORDER_STATUSES.includes(workOrderStatus)) {
    throw handymanWorkSessionExecutionStateInvalidError(
      `Work order status ${workOrderStatus} does not permit starting execution.`,
    );
  }
}

/** §4 START authority: LEAD of the visit's CURRENT composition crew. */
async function requireSessionStartActor(
  chain: ArrivalChainContext,
  actorUserId: string,
): Promise<void> {
  const actorBindingIds =
    await resolveFieldActorActiveBindingIds(actorUserId);
  if (actorBindingIds.length === 0) {
    throw handymanWorkSessionActorNotLeadError();
  }
  const lead = await handymanWorkCrewRepository.findActiveLead(
    chain.handymanWorkCrewId,
  );
  if (!lead || !actorBindingIds.includes(lead.vendorWorkforceBindingId)) {
    throw handymanWorkSessionActorNotLeadError();
  }
}

/**
 * §13 END authority (the smallest auditable rule): the actor resolves to
 * the CURRENT ACTIVE lead membership of EITHER the session's immutable
 * start-context crew (historical authority — the crew that opened the
 * window can close it even after reassignment) OR the visit's current
 * ACTIVE composition crew (operational continuity — the current lead can
 * close an orphaned open window). The actual closing actor is recorded on
 * the row (ended_by_user_id), so every closure is auditable.
 */
async function requireSessionEndAuthority(
  visit: HandymanServiceVisitRecord,
  session: HandymanWorkSessionRecord,
  actorUserId: string,
): Promise<void> {
  const actorBindingIds =
    await resolveFieldActorActiveBindingIds(actorUserId);
  if (actorBindingIds.length === 0) {
    throw handymanWorkSessionActorNotLeadError();
  }
  const crewIds = new Set<string>();
  const assignments = await handymanJobRepository.listAssignmentsByJobId(
    visit.handymanJobId,
  );
  const startAssignment = assignments.find(
    (assignment) => assignment.id === session.handymanJobAssignmentId,
  );
  if (startAssignment) {
    crewIds.add(startAssignment.handymanWorkCrewId);
  }
  const currentComposition = await handymanJobRepository.findActiveByJobId(
    visit.handymanJobId,
  );
  if (currentComposition) {
    crewIds.add(currentComposition.handymanWorkCrewId);
  }
  for (const crewId of crewIds) {
    const lead = await handymanWorkCrewRepository.findActiveLead(crewId);
    if (lead && actorBindingIds.includes(lead.vendorWorkforceBindingId)) {
      return;
    }
  }
  throw handymanWorkSessionActorNotLeadError();
}

/**
 * §6 Phases 2–3 — the guarded execution-start seam, replay-convergent.
 *
 * Phase 2: vendor work NOT_STARTED → IN_PROGRESS through the OWNING BE-15B
 * transition (which emits its own VENDOR_WORK_STATUS_CHANGED event). If it
 * fails, the work order is never touched and a replay converges.
 * Phase 3: only with vendor work IN_PROGRESS, work order ASSIGNED →
 * IN_PROGRESS through the OWNING BE-08C transition. The work order is never
 * ahead of its vendor work.
 *
 * Case D (work order IN_PROGRESS over vendor work NOT_STARTED) always fails
 * with the owned inconsistency error. Worlds that legitimately advanced
 * past the start states (ON_HOLD/COMPLETED/CANCELLED on either side) are
 * converged as-is: a late replay never forces or regresses a transition.
 */
async function convergeExecutionStartSeam(
  session: HandymanWorkSessionRecord,
): Promise<HandymanExecutionStartState> {
  const visit = await handymanServiceVisitRepository.findVisitById(
    session.visitId,
  );
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  const job = await handymanJobRepository.findById(visit.handymanJobId);
  if (!job) {
    throw handymanJobNotAssignedError();
  }
  const vendorWork = await vendorWorkRepository.findById(session.vendorWorkId);
  if (!vendorWork) {
    throw vendorWorkNotFoundError();
  }
  const workOrderRecord = await workOrderRepository.findById(job.workOrderId);
  if (!workOrderRecord) {
    throw workOrderNotFoundError();
  }

  let vendorWorkStatus: string = vendorWork.status;
  let workOrderStatus: string = workOrderRecord.status;
  if (vendorWorkStatus === 'NOT_STARTED' && workOrderStatus === 'IN_PROGRESS') {
    // §7 Case D — explicit owned failure, never a silent normalization.
    throw handymanWorkSessionExecutionStateInconsistentError();
  }

  const seamConverged =
    LEGAL_START_VENDOR_WORK_STATUSES.includes(vendorWorkStatus) &&
    LEGAL_START_WORK_ORDER_STATUSES.includes(workOrderStatus);

  if (seamConverged) {
    // Phase 2 — vendor work first (BE-15B owns the transition + its event).
    if (vendorWorkStatus === 'NOT_STARTED') {
      try {
        const advanced = await transitionVendorWorkStatus(vendorWork.id, {
          status: 'IN_PROGRESS',
        });
        vendorWorkStatus = advanced.status;
      } catch (error) {
        // Concurrent convergers: tolerate ONLY the owning module's
        // invalid-transition rejection, and only when the re-read proves
        // the target state was already reached. Anything else propagates
        // (the work order is then never touched and a replay converges).
        if (
          !(error instanceof AppError) ||
          error.code !== ERROR_CODES.VENDOR_WORK_INVALID_TRANSITION
        ) {
          throw error;
        }
        const reread = await vendorWorkRepository.findById(vendorWork.id);
        if (!reread || reread.status !== 'IN_PROGRESS') {
          throw error;
        }
        vendorWorkStatus = reread.status;
      }
    }
    // Phase 3 — only after vendor work is IN_PROGRESS (BE-08C owns it).
    if (vendorWorkStatus === 'IN_PROGRESS' && workOrderStatus === 'ASSIGNED') {
      try {
        const advanced = await transitionWorkOrderStatus(job.workOrderId, {
          status: 'IN_PROGRESS',
        });
        workOrderStatus = advanced.status;
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          error.code !== ERROR_CODES.WORK_ORDER_INVALID_TRANSITION
        ) {
          throw error;
        }
        const reread = await workOrderRepository.findById(job.workOrderId);
        if (!reread || reread.status !== 'IN_PROGRESS') {
          throw error;
        }
        workOrderStatus = reread.status;
      }
    }
  }

  return { vendorWorkStatus, workOrderStatus };
}

/**
 * Convergence rule for an EXISTING session fact (§8): an OPEN window is
 * never adopted by a different actor (409), while a same-actor OPEN window
 * and any CLOSED history converge — and the guarded seam is re-run so
 * replays complete Cases A/B.
 */
async function convergeStart(
  existing: HandymanWorkSessionRecord,
  actorUserId: string,
): Promise<HandymanWorkSessionStartResult> {
  if (
    existing.status === 'OPEN' &&
    existing.startedByUserId !== actorUserId
  ) {
    throw handymanWorkSessionAlreadyOpenError();
  }
  const execution = await convergeExecutionStartSeam(existing);
  return {
    session: toPublicHandymanWorkSession(existing),
    converged: true,
    execution,
  };
}

async function requireVisitForSession(
  visitId: string,
): Promise<HandymanServiceVisitRecord> {
  const visit = await handymanServiceVisitRepository.findVisitById(visitId);
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  return visit;
}

/* ------------------------------------------------------------------ */
/* START (§2/§3/§6/§7/§8/§9/§10/§11)                                   */
/* ------------------------------------------------------------------ */

/**
 * Opens the visit's execution window and drives the guarded execution-start
 * seam. Input is business/replay facts only (§2): everything authoritative
 * is resolved server-side from the visit and the authenticated actor.
 */
export async function startHandymanWorkSession(
  visitId: string,
  input: StartHandymanWorkSessionInput,
  actorUserId: string,
): Promise<HandymanWorkSessionStartResult> {
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (!idempotencyKey) {
    throw handymanWorkSessionIdempotencyKeyRequiredError();
  }
  let occurredAt: Date | null = null;
  if (
    input.occurredAt !== undefined &&
    input.occurredAt !== null &&
    input.occurredAt !== ''
  ) {
    const parsed = new Date(input.occurredAt);
    if (Number.isNaN(parsed.getTime())) {
      throw handymanWorkSessionEvidenceInvalidError(
        'occurredAt must be a parseable ISO-8601 timestamp claim.',
      );
    }
    occurredAt = parsed;
  }
  const fingerprint = computeStartFingerprint(visitId, occurredAt);

  // Structural field context + chain + §4 lead authority (pool level).
  const visit = await requireVisitForSession(visitId);
  const jobContext = await loadFieldJobContext(visit.handymanJobId);
  const chain = await requireArrivalChain(jobContext);
  await requireSessionStartActor(chain, actorUserId);

  // §3.B — an ACTIVE schedule window must exist.
  const activeSchedule =
    await handymanServiceVisitRepository.findActiveScheduleByVisitId(visitId);
  if (!activeSchedule) {
    throw handymanServiceVisitNotSchedulableError();
  }

  // §3.F/G/H — consume the Run-1 VERIFIED arrival + frozen presence
  // snapshot as-is (never rebuilt; helpers stay informational).
  const verifiedArrival =
    await handymanVisitArrivalRepository.findVerifiedByVisitId(visitId);
  if (!verifiedArrival) {
    throw handymanWorkSessionArrivalRequiredError();
  }
  const presence = await evaluateHandymanVisitExecutionPresence(visitId);
  if (!presence.snapshotExists) {
    throw handymanWorkSessionStateInvalidError(
      'The frozen crew presence snapshot is missing for the verified arrival.',
    );
  }
  if (!presence.leadPresent) {
    throw handymanWorkSessionLeadNotPresentError();
  }

  // §3.I — BE-05 readiness (ONE semantic authority, §11 core) must be
  // ready=true with the §3.K execution-start work-order predicate.
  const readiness =
    await assessHandymanServiceVisitExecutionReadinessCore(
      visit,
      jobContext,
      actorUserId,
      FIELD_START_READINESS_SUBREADS,
    );
  if (!readiness.ready) {
    const failedChecks = Object.entries(readiness.checks)
      .filter(([, satisfied]) => !satisfied)
      .map(([name]) => name);
    throw handymanWorkSessionExecutionNotReadyError(failedChecks);
  }

  // §8 fast paths (outside the decisive tx): key replay first, then the
  // structural one-OPEN rule. A replay NEVER re-adjudicates preconditions —
  // it converges onto the recorded fact and completes the seam.
  const existingByKey =
    await handymanWorkSessionRepository.findByIdempotencyKey(
      visit.clientId,
      idempotencyKey,
    );
  if (existingByKey) {
    if (existingByKey.idempotencyFingerprint !== fingerprint) {
      throw handymanWorkSessionIdempotencyConflictError();
    }
    return convergeStart(existingByKey, actorUserId);
  }
  const openSession =
    await handymanWorkSessionRepository.findOpenByVisitId(visitId);
  if (openSession) {
    return convergeStart(openSession, actorUserId);
  }

  // §6 Phase 1 — the decisive operation: ONE Handyman transaction. Lock
  // order (§9): the Run-2 visit-path family VERBATIM (visit → ACTIVE
  // schedule → job → work order → ACTIVE composition → crew → designation →
  // vendor → relationship → sorted bindings, via the Run-1 reassertion),
  // then the RELATED execution rows appended at the tail (vendor work lock,
  // arrival/presence re-reads, session rows) — tail-append keeps the single
  // established family with no inversion (BE-15B's own transitions lock the
  // vendor work row alone, in short post-commit transactions).
  const decisive = await withTransaction(async (tx) => {
    const locked = await reassertArrivalContextInTx(visitId, chain, tx);

    // §3.J — the vendor work resolved from the DECISIVE composition, row-
    // locked, then the combined start-state assertion under both locks.
    const vendorWork =
      await handymanJobRepository.findVendorWorkByAssignmentId(
        locked.vendorAssignmentId,
        tx,
      );
    if (!vendorWork) {
      throw handymanJobNotAssignedError();
    }
    const lockedVendorWork =
      await handymanWorkSessionRepository.lockVendorWorkForExecutionStart(
        vendorWork.id,
        tx,
      );
    if (!lockedVendorWork) {
      throw handymanWorkSessionStateInvalidError(
        'The vendor work row vanished during the start operation.',
      );
    }
    assertExecutionStartStates(
      lockedVendorWork.status,
      locked.workOrderStatus,
    );

    // §3.F/H under the visit lock (arrival/presence marks serialize on it).
    const verifiedInTx =
      await handymanVisitArrivalRepository.findVerifiedByVisitId(visitId, tx);
    if (!verifiedInTx) {
      throw handymanWorkSessionArrivalRequiredError();
    }
    const presenceRows = await handymanVisitPresenceRepository.listByVisitId(
      visitId,
      tx,
    );
    const leadRow = presenceRows.find(
      (row) => row.crewRole === 'LEAD_WORKER',
    );
    if (!leadRow || leadRow.presenceStatus !== 'PRESENT') {
      throw handymanWorkSessionLeadNotPresentError();
    }

    // §8 under the locks: key replay + the structural one-OPEN rule.
    const keyInTx = await handymanWorkSessionRepository.findByIdempotencyKey(
      visit.clientId,
      idempotencyKey,
      tx,
    );
    if (keyInTx) {
      if (keyInTx.idempotencyFingerprint !== fingerprint) {
        throw handymanWorkSessionIdempotencyConflictError();
      }
      return { record: keyInTx, created: false };
    }
    const openInTx = await handymanWorkSessionRepository.findOpenByVisitId(
      visitId,
      tx,
    );
    if (openInTx) {
      return { record: openInTx, created: false };
    }

    const newSession: NewHandymanWorkSession = {
      clientId: visit.clientId,
      visitId,
      // §1 — the execution context frozen at START (historical authority).
      vendorWorkId: lockedVendorWork.id,
      handymanJobAssignmentId: locked.compositionId,
      startedByUserId: actorUserId,
      occurredAt,
      idempotencyKey,
      idempotencyFingerprint: fingerprint,
    };
    const { record, created } = await handymanWorkSessionRepository.create(
      newSession,
      tx,
    );
    if (!created) {
      // A concurrent duplicate won the client-key unique; fingerprint
      // decides replay-convergence vs conflict (the Run-1 convention).
      if (record.idempotencyFingerprint !== fingerprint) {
        throw handymanWorkSessionIdempotencyConflictError();
      }
      return { record, created: false };
    }

    // §14 — session-start audit inside the same transaction. IDs, statuses
    // and timestamps only: no PII, no GPS, no device data, no billing.
    await recordOperationalEvent(
      {
        clientId: visit.clientId,
        eventType: 'HANDYMAN_WORK_SESSION_STARTED',
        entityType: 'HANDYMAN_WORK_SESSION',
        entityId: record.id,
        actorUserId,
        buildingId: locked.buildingId,
        vendorWorkId: record.vendorWorkId,
        summary: `Handyman work session opened for visit ${locked.visitSequence}`,
        metadata: {
          handymanServiceVisitId: visitId,
          visitSequence: locked.visitSequence,
          handymanJobId: visit.handymanJobId,
          handymanJobAssignmentId: record.handymanJobAssignmentId,
          vendorWorkId: record.vendorWorkId,
          status: record.status,
          startedAt: record.startedAt.toISOString(),
        },
      },
      tx,
    );
    return { record, created: true };
  });

  if (!decisive.created) {
    // Same convergence rule as the fast paths, applied to the decisive
    // result (an OPEN window is never adopted by a different actor).
    return convergeStart(decisive.record, actorUserId);
  }

  // §6 Phases 2–3 — post-commit guarded seam on the freshly opened session.
  const execution = await convergeExecutionStartSeam(decisive.record);
  return {
    session: toPublicHandymanWorkSession(decisive.record),
    converged: false,
    execution,
  };
}

/* ------------------------------------------------------------------ */
/* END (§12/§13)                                                       */
/* ------------------------------------------------------------------ */

/**
 * Closes the session: OPEN → CLOSED with server-stamped ended_at and the
 * real closing actor, guarded + replay-safe (a CLOSED session converges).
 * NEVER touches vendor work, work orders, QC, BAST, invoices, payroll, or
 * settlements — execution completion stays owned by BE-15B/BE-08C and the
 * quality/acceptance foundations. A later NEW session may start again if
 * the §3 preconditions remain legal.
 */
export async function endHandymanWorkSession(
  sessionId: string,
  actorUserId: string,
): Promise<HandymanWorkSessionEndResult> {
  const session = await handymanWorkSessionRepository.findById(sessionId);
  if (!session) {
    throw handymanWorkSessionNotFoundError();
  }
  if (session.status === 'CLOSED') {
    // Replay-safe: the recorded closure converges, attribution intact.
    return { session: toPublicHandymanWorkSession(session), converged: true };
  }
  const visit = await requireVisitForSession(session.visitId);
  await requireSessionEndAuthority(visit, session, actorUserId);

  const closed = await withTransaction(async (tx) => {
    const locked = await handymanWorkSessionRepository.lockById(
      sessionId,
      tx,
    );
    if (!locked) {
      throw handymanWorkSessionNotFoundError();
    }
    if (locked.status === 'CLOSED') {
      return { record: locked, converged: true };
    }
    const updated = await handymanWorkSessionRepository.closeSession(
      sessionId,
      actorUserId,
      tx,
    );
    if (!updated) {
      // A concurrent close won between the lock read and the guarded
      // update (structurally unreachable under the row lock; never guess).
      const reread = await handymanWorkSessionRepository.findById(
        sessionId,
        tx,
      );
      if (!reread || reread.status !== 'CLOSED') {
        throw handymanWorkSessionStateInvalidError();
      }
      return { record: reread, converged: true };
    }
    await recordOperationalEvent(
      {
        clientId: session.clientId,
        eventType: 'HANDYMAN_WORK_SESSION_ENDED',
        entityType: 'HANDYMAN_WORK_SESSION',
        entityId: updated.id,
        actorUserId,
        vendorWorkId: updated.vendorWorkId,
        summary: `Handyman work session closed for visit ${session.visitId}`,
        metadata: {
          handymanServiceVisitId: session.visitId,
          handymanJobAssignmentId: updated.handymanJobAssignmentId,
          vendorWorkId: updated.vendorWorkId,
          status: updated.status,
          startedAt: updated.startedAt.toISOString(),
          endedAt: updated.endedAt ? updated.endedAt.toISOString() : null,
        },
      },
      tx,
    );
    return { record: updated, converged: false };
  });

  return {
    session: toPublicHandymanWorkSession(closed.record),
    converged: closed.converged,
  };
}

/* ------------------------------------------------------------------ */
/* Reads (§15 — the Run-3 HTTP surface)                                */
/* ------------------------------------------------------------------ */

/**
 * Read access: staff client scope (BE-02G), OR the field actor that started
 * any session of the visit, OR the current ACTIVE lead of the visit's
 * current composition crew. IDs/statuses/timestamps only — no worker PII,
 * no GPS, no device data, no billing fields exist on the read model.
 */
async function assertSessionReadAccess(
  visit: HandymanServiceVisitRecord,
  actorUserId: string,
  sessions: HandymanWorkSessionRecord[],
): Promise<void> {
  if (await contextAccessService.canAccessClient(actorUserId, visit.clientId)) {
    return;
  }
  if (sessions.some((session) => session.startedByUserId === actorUserId)) {
    return;
  }
  const actorBindingIds =
    await resolveFieldActorActiveBindingIds(actorUserId);
  if (actorBindingIds.length > 0) {
    const composition = await handymanJobRepository.findActiveByJobId(
      visit.handymanJobId,
    );
    if (composition) {
      const lead = await handymanWorkCrewRepository.findActiveLead(
        composition.handymanWorkCrewId,
      );
      if (lead && actorBindingIds.includes(lead.vendorWorkforceBindingId)) {
        return;
      }
    }
  }
  throw buildingAccessDeniedError();
}

/** Full session history of one visit, oldest first (§15). */
export async function listHandymanWorkSessionsByVisit(
  visitId: string,
  actorUserId: string,
): Promise<PublicHandymanWorkSession[]> {
  const visit = await requireVisitForSession(visitId);
  const rows = await handymanWorkSessionRepository.listByVisitId(visitId);
  await assertSessionReadAccess(visit, actorUserId, rows);
  return rows.map(toPublicHandymanWorkSession);
}

/** One session by id (§15). */
export async function getHandymanWorkSessionById(
  sessionId: string,
  actorUserId: string,
): Promise<PublicHandymanWorkSession> {
  const session = await handymanWorkSessionRepository.findById(sessionId);
  if (!session) {
    throw handymanWorkSessionNotFoundError();
  }
  const visit = await requireVisitForSession(session.visitId);
  await assertSessionReadAccess(visit, actorUserId, [session]);
  return toPublicHandymanWorkSession(session);
}

export const handymanWorkSessionService = {
  startHandymanWorkSession,
  endHandymanWorkSession,
  getHandymanWorkSessionById,
  listHandymanWorkSessionsByVisit,
  toPublicHandymanWorkSession,
};

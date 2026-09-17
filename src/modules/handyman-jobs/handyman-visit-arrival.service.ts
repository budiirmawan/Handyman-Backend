import { createHash } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import {
  clientInactiveError,
  clientNotFoundError,
  clientRepository,
} from '../clients';
import { handymanProviderRepository } from '../handyman-providers';
import {
  handymanRequestNotFoundError,
  handymanRequestRepository,
} from '../handyman-requests';
import {
  handymanWorkCrewRepository,
  type HandymanWorkCrewMemberRecord,
} from '../handyman-work-crews';
import { recordOperationalEvent } from '../operational-events';
import {
  toPublicWorkOrder,
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import {
  handymanJobAssignmentStateInvalidError,
  handymanJobContextMismatchError,
  handymanJobNotAssignedError,
  handymanJobNotFoundError,
} from './handyman-job.errors';
import { handymanJobRepository } from './handyman-job.repository';
import {
  loadJobContext,
  requireOperationalCrewChain,
  type JobContext,
} from './handyman-job.service';
import {
  decideGpsArrival,
  resolveArrivalVerificationPolicy,
  type ArrivalPolicyResolution,
  type GpsArrivalClaim,
} from './handyman-arrival-verification';
import {
  handymanServiceVisitNotFoundError,
  handymanServiceVisitNotSchedulableError,
} from './handyman-service-visit.errors';
import { handymanServiceVisitRepository } from './handyman-service-visit.repository';
import {
  handymanVisitArrivalActorNotLeadError,
  handymanVisitArrivalAssistedReasonRequiredError,
  handymanVisitArrivalEvidenceInvalidError,
  handymanVisitArrivalIdempotencyConflictError,
  handymanVisitArrivalIdempotencyKeyRequiredError,
  handymanVisitArrivalStateInvalidError,
} from './handyman-visit-arrival.errors';
import {
  handymanVisitArrivalRepository,
  type NewHandymanVisitArrival,
} from './handyman-visit-arrival.repository';
import type {
  HandymanVisitArrivalCommandResult,
  HandymanVisitArrivalRecord,
  PublicHandymanVisitArrival,
  RecordAssistedArrivalInput,
  RecordGpsArrivalInput,
} from './handyman-visit-arrival.types';
import {
  assertHandymanVisitExecutionReadAccess,
  resolveFieldActorActiveBindingIds,
} from './handyman-visit-lead-chain';
import { handymanVisitPresenceRepository } from './handyman-visit-presence.repository';
import { toPublicHandymanVisitPresence } from './handyman-visit-presence.service';

/**
 * CR-HM-BE-06 RUN 1 — Handyman visit arrival authority.
 *
 * Arrival is a VERIFIED VISIT FACT and nothing else: it is not attendance,
 * not a work-order or vendor-work transition, not tenant acceptance and not
 * a work-session start. It only unlocks presence capture and is a
 * precondition of the (Run-2) execution start.
 *
 * Governance encoded here:
 * - APPEND-ONLY ATTEMPTS: every command records an immutable attempt row
 *   (or converges onto an existing one). There is no mutable verified flag
 *   anywhere — "the visit has arrived" is exactly the existence of its one
 *   VERIFIED attempt (partial unique index). FAILED GPS attempts accumulate
 *   as honest history; a later attempt may verify.
 * - SERVER-DECIDED VERIFICATION: raw client GPS is evidence input only.
 *   The server resolves the canonical building from the existing job →
 *   work-order chain, resolves the ACTIVE, version-ACTIVATED arrival policy
 *   (BE-27B + BE-27N/O reuse under the Handyman-owned key), validates it
 *   fail-closed (NO magic/default radius, NO client radius, NO client
 *   policy point), computes the deterministic haversine distance and owns
 *   the VERIFIED/FAILED result with an owned reason. The exact
 *   configuration + version provenance used is pinned on the attempt.
 * - ASSISTED is a provenance-bearing staff override, never fake GPS:
 *   mandatory non-empty reason, the real recorder, no coordinates, and it
 *   never rewrites a prior FAILED GPS attempt. It is deliberately NOT
 *   policy-gated — ASSISTED is the governed fallback for exactly the
 *   fail-closed policy states (absent/invalid/disabled configuration).
 * - FIELD vs STAFF actor authority: the GPS command's actor is authorized
 *   through the governed lead chain (authenticated user → BE-03C profile →
 *   ACTIVE BE-06F binding → ACTIVE crew membership → LEAD_WORKER of the
 *   visit's composition) — NO hardcoded RBAC role names, and helpers never
 *   authenticate. The ASSISTED command's actor is a staff recorder through
 *   the EXISTING BE-05 visit-management access idiom (loadJobContext).
 * - COMMAND-TIME REVALIDATION (§6) reuses the BE-05 authorities: visit +
 *   ACTIVE schedule + job + ACTIVE assignment + provider/vendor/building
 *   relationship + crew chain + canonical building context. The work order
 *   row is LOCKED (lock-order family compliance) but its STATUS is
 *   deliberately NOT gated: arrival neither requires nor causes any
 *   execution state — a later visit of the same job may arrive while the
 *   work order is already IN_PROGRESS.
 * - CREW PRESENCE SNAPSHOT: the first VERIFIED arrival atomically snapshots
 *   the ACTIVE crew composition (same transaction — if the snapshot fails,
 *   the VERIFIED arrival does not survive alone).
 *
 * CONCURRENCY / LOCKING (BE-05 P2 discipline — NO third lock-order family):
 * the in-transaction order is the Run-2 visit path VERBATIM:
 *   visit → ACTIVE schedule → job → work order → composition (stale guard)
 *   → crew → provider designation → vendor → vendor-building relationship
 *   → crew worker chain (binding rows in ascending id order).
 * The visit-row lock is the single-winner serialization point per visit;
 * the client-scoped idempotency unique constraint and the one-VERIFIED
 * partial unique index are the structural backstops, and both races
 * converge onto the winner's row instead of erroring.
 *
 * IDEMPOTENCY (the CR-HM-BE-01 convention): client-supplied key + command
 * fingerprint, unique per CLIENT. Replay with the same key and the same
 * material facts returns the ORIGINAL attempt; the same key with
 * materially different facts is a 409 conflict; a NEW key always records a
 * NEW attempt (idempotency never suppresses legitimate FAILED history).
 * Once the visit has a VERIFIED arrival, any further arrival command
 * converges onto it (no second VERIFIED arrival is ever created, and no
 * junk attempts are appended after the fact is established).
 *
 * Boundary: this service NEVER transitions the work order, NEVER starts
 * vendor work, NEVER creates a work session, and touches no attendance,
 * material, QC, BAST, invoice, fee, warranty or notification authority.
 *
 * Audit: HANDYMAN_VISIT_ARRIVAL_RECORDED with IDs, method, result, failure
 * reason and policy provenance ids only — never raw coordinates, never the
 * computed distance, never customer/worker PII, never free-text reasons
 * (the assisted reason lives on the attempt row itself).
 */

const UNIQUE_VIOLATION = '23505';
const ARRIVALS_ONE_VERIFIED = 'handyman_visit_arrivals_one_verified_per_visit';
const ARRIVALS_CLIENT_IDEMPOTENCY =
  'handyman_visit_arrivals_client_idempotency_unique';

export function toPublicHandymanVisitArrival(
  record: HandymanVisitArrivalRecord,
): PublicHandymanVisitArrival {
  // Privacy canary: the raw claimed coordinates, the accuracy and the
  // computed distance stay on the evidence row and are NEVER part of the
  // public read model.
  return {
    id: record.id,
    clientId: record.clientId,
    handymanServiceVisitId: record.handymanServiceVisitId,
    verificationMethod: record.verificationMethod,
    verificationResult: record.verificationResult,
    receivedAt: record.receivedAt.toISOString(),
    occurredAt: record.occurredAt ? record.occurredAt.toISOString() : null,
    buildingConfigurationId: record.buildingConfigurationId,
    configurationVersionId: record.configurationVersionId,
    assistedReason: record.assistedReason,
    failureReason: record.failureReason,
    recordedByUserId: record.recordedByUserId,
    createdAt: record.createdAt.toISOString(),
  };
}

function uniqueViolationConstraint(error: unknown): string | null {
  if (
    !(error instanceof Error) ||
    (error as { code?: string }).code !== UNIQUE_VIOLATION
  ) {
    return null;
  }
  return (error as { constraint?: string }).constraint ?? null;
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw handymanVisitArrivalIdempotencyKeyRequiredError();
  }
  return value;
}

/** Client-claimed occurrence time — evidence only, never authoritative. */
function coerceOccurredAt(value: Date | string | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw handymanVisitArrivalEvidenceInvalidError(
      'occurredAt must be a valid timestamp when provided.',
    );
  }
  return date;
}

function fingerprintNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Material-facts fingerprint (the CR-HM-BE-01 idiom): same key + same
 * fingerprint = replay; same key + different fingerprint = conflict. The
 * actor is a material fact — the same key under a different recorder is a
 * different command, never a replay.
 */
export function computeArrivalFingerprint(facts: {
  handymanServiceVisitId: string;
  verificationMethod: 'GPS' | 'ASSISTED';
  recordedByUserId: string;
  latitude?: number | null;
  longitude?: number | null;
  accuracyMeters?: number | null;
  occurredAt: Date | null;
  assistedReason: string | null;
}): string {
  const canonical = JSON.stringify({
    handymanServiceVisitId: facts.handymanServiceVisitId,
    verificationMethod: facts.verificationMethod,
    recordedByUserId: facts.recordedByUserId,
    latitude: fingerprintNumber(facts.latitude ?? null),
    longitude: fingerprintNumber(facts.longitude ?? null),
    accuracyMeters: fingerprintNumber(facts.accuracyMeters ?? null),
    occurredAt: facts.occurredAt ? facts.occurredAt.toISOString() : null,
    assistedReason: facts.assistedReason,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Context + chain resolution (BE-05 authorities, composed read-only)  */
/* ------------------------------------------------------------------ */

/**
 * The structural core of the BE-05 loadJobContext WITHOUT its staff
 * context-access assertion — used exclusively for the FIELD actor path,
 * where access is proven by the governed lead chain instead of building
 * assignments (external lead workers hold no staff context by design).
 * All structural integrity checks are reproduced verbatim.
 */
/**
 * Structural job-context load for FIELD-authorized command chains
 * (exported for CR-HM-BE-06 Run 2 composition): the same integrity
 * assertions as the BE-05 staff loadJobContext — job/client/request/work
 * order existence, ACTIVE client, one-client coherence — WITHOUT the
 * BE-02G building-assignment access gate that external workforce leads can
 * never satisfy. Authorization for callers of this load is the BE-06 lead
 * chain (user → BE-03C profile → ACTIVE vendor binding → ACTIVE membership
 * → LEAD of the visit's composition), asserted separately.
 */
export async function loadFieldJobContext(jobId: string): Promise<JobContext> {
  const job = await handymanJobRepository.findById(jobId);
  if (!job) {
    throw handymanJobNotFoundError();
  }
  const client = await clientRepository.findById(job.clientId);
  if (!client) {
    throw clientNotFoundError();
  }
  if (client.status !== 'ACTIVE') {
    throw clientInactiveError();
  }
  const request = await handymanRequestRepository.findById(
    job.handymanRequestId,
  );
  if (!request) {
    throw handymanRequestNotFoundError();
  }
  const workOrderRecord = await workOrderRepository.findById(job.workOrderId);
  if (!workOrderRecord) {
    throw workOrderNotFoundError();
  }
  if (
    request.clientId !== job.clientId ||
    workOrderRecord.clientId !== job.clientId ||
    workOrderRecord.buildingId !== request.buildingId
  ) {
    throw handymanJobContextMismatchError();
  }
  return { job, request, workOrder: toPublicWorkOrder(workOrderRecord) };
}

/** Visit-scoped execution chain resolved from business facts (Run 2 reuse). */
export type ArrivalChainContext = {
  jobContext: JobContext;
  compositionId: string;
  vendorAssignmentId: string;
  handymanProviderId: string;
  vendorId: string;
  handymanWorkCrewId: string;
};

/**
 * Resolves the visit's authoritative execution chain from business facts
 * (the BE-05 requireSchedulingContext semantics, recomposed here from the
 * exported owning repositories — BE-05 stays frozen): ACTIVE composition →
 * its BE-15A vendor assignment → crew ↔ provider ↔ vendor coherence.
 */
export async function requireArrivalChain(
  jobContext: JobContext,
): Promise<ArrivalChainContext> {
  const composition = await handymanJobRepository.findActiveByJobId(
    jobContext.job.id,
  );
  if (!composition) {
    throw handymanJobNotAssignedError();
  }
  const vendorAssignment = await handymanJobRepository.findVendorAssignmentById(
    composition.vendorAssignmentId,
  );
  if (!vendorAssignment) {
    throw handymanJobAssignmentStateInvalidError(
      'The active handyman job assignment lost its vendor assignment.',
    );
  }
  const crew = await handymanWorkCrewRepository.findById(
    composition.handymanWorkCrewId,
  );
  if (!crew || crew.clientId !== jobContext.job.clientId) {
    throw handymanJobAssignmentStateInvalidError(
      'The assigned crew no longer resolves for this job.',
    );
  }
  const designation = await handymanProviderRepository.findById(
    crew.handymanProviderId,
  );
  if (!designation || designation.vendorId !== vendorAssignment.vendorId) {
    throw handymanJobAssignmentStateInvalidError(
      'The active handyman job assignment no longer resolves to one provider and vendor.',
    );
  }
  return {
    jobContext,
    compositionId: composition.id,
    vendorAssignmentId: composition.vendorAssignmentId,
    handymanProviderId: designation.id,
    vendorId: designation.vendorId,
    handymanWorkCrewId: crew.id,
  };
}

/**
 * Field-actor authorization: the authenticated user must resolve through
 * the governed chain to the LEAD_WORKER membership of the visit's assigned
 * crew. Anything else — no profile, an inactive profile, no ACTIVE binding,
 * a binding outside this crew, or a non-lead membership — is a 403. No
 * hardcoded RBAC role names are involved.
 */
async function requireLeadActorForCrew(
  handymanWorkCrewId: string,
  actorUserId: string,
): Promise<void> {
  const actorBindingIds = await resolveFieldActorActiveBindingIds(actorUserId);
  if (actorBindingIds.length === 0) {
    throw handymanVisitArrivalActorNotLeadError();
  }
  const lead = await handymanWorkCrewRepository.findActiveLead(
    handymanWorkCrewId,
  );
  if (!lead || !actorBindingIds.includes(lead.vendorWorkforceBindingId)) {
    throw handymanVisitArrivalActorNotLeadError();
  }
}

async function requireVisitForArrival(visitId: string) {
  const visit = await handymanServiceVisitRepository.findVisitById(visitId);
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  return visit;
}

async function requireActiveScheduleForArrival(visitId: string): Promise<void> {
  const schedule =
    await handymanServiceVisitRepository.findActiveScheduleByVisitId(visitId);
  if (!schedule) {
    throw handymanServiceVisitNotSchedulableError();
  }
}

/* ------------------------------------------------------------------ */
/* In-transaction re-assertion (Run-2 visit-path lock order VERBATIM)  */
/* ------------------------------------------------------------------ */

export type LockedArrivalContext = {
  lockedScheduleId: string;
  compositionId: string;
  vendorAssignmentId: string;
  workOrderStatus: string;
  handymanWorkCrewId: string;
  members: HandymanWorkCrewMemberRecord[];
  buildingId: string;
  visitSequence: number;
};

/**
 * Re-asserts every §6 fact under the locks, in the Run-2 visit-path order
 * verbatim: visit → ACTIVE schedule → job → work order → composition
 * (stale guard) → crew → designation → vendor → relationship → sorted
 * worker binding locks. The work-order STATUS is deliberately not asserted
 * (arrival is execution-state neutral); its row lock only keeps this path
 * inside the single established lock-order family. Returns the ACTIVE crew
 * members for the presence snapshot.
 */
export async function reassertArrivalContextInTx(
  visitId: string,
  chain: ArrivalChainContext,
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
): Promise<LockedArrivalContext> {
  const lockedVisit = await handymanServiceVisitRepository.lockVisitById(
    visitId,
    tx,
  );
  if (!lockedVisit) {
    throw handymanServiceVisitNotFoundError();
  }
  const lockedSchedule =
    await handymanServiceVisitRepository.lockActiveScheduleByVisitId(
      visitId,
      tx,
    );
  if (!lockedSchedule) {
    throw handymanServiceVisitNotSchedulableError();
  }
  const lockedJob = await handymanJobRepository.lockById(
    chain.jobContext.job.id,
    tx,
  );
  if (!lockedJob) {
    throw handymanJobNotFoundError();
  }
  const lockedWorkOrder =
    await handymanJobRepository.lockWorkOrderForComposition(
      lockedJob.workOrderId,
      tx,
    );
  if (!lockedWorkOrder) {
    throw workOrderNotFoundError();
  }
  const compositionInTx = await handymanJobRepository.findActiveByJobId(
    lockedJob.id,
    tx,
  );
  if (!compositionInTx) {
    throw handymanJobNotAssignedError();
  }
  if (compositionInTx.id !== chain.compositionId) {
    // A concurrent reassignment changed the composition this command
    // validated against — stale context, never guess (the BE-05 idiom).
    throw handymanJobAssignmentStateInvalidError(
      'The active handyman job assignment changed during this operation.',
    );
  }
  const lockedCrew = await handymanWorkCrewRepository.lockById(
    chain.handymanWorkCrewId,
    tx,
  );
  if (!lockedCrew || lockedCrew.status !== 'ACTIVE') {
    throw handymanJobAssignmentStateInvalidError(
      'The assigned crew is no longer active.',
    );
  }
  const designationInTx = await handymanJobRepository.lockProviderDesignation(
    chain.handymanProviderId,
    tx,
  );
  if (
    !designationInTx ||
    designationInTx.status !== 'ACTIVE' ||
    designationInTx.vendorId !== chain.vendorId
  ) {
    throw handymanJobAssignmentStateInvalidError(
      'The assigned provider designation is no longer assignable.',
    );
  }
  const vendorInTx = await handymanJobRepository.lockVendor(
    chain.vendorId,
    tx,
  );
  if (!vendorInTx || vendorInTx.status !== 'ACTIVE') {
    throw handymanJobAssignmentStateInvalidError(
      'The assigned vendor is no longer active.',
    );
  }
  const relationshipInTx =
    await handymanJobRepository.findActiveVendorBuildingRelationship(
      chain.vendorId,
      lockedWorkOrder.buildingId,
      tx,
    );
  if (!relationshipInTx) {
    throw handymanJobAssignmentStateInvalidError(
      'The vendor-building relationship of the assignment is no longer active.',
    );
  }
  // Binding-row locks in ascending id order (deadlock-free acquisition).
  await requireOperationalCrewChain(
    chain.handymanWorkCrewId,
    chain.handymanProviderId,
    chain.vendorId,
    lockedJob.clientId,
    tx,
    false,
  );
  const members = await handymanWorkCrewRepository.listMembers(
    chain.handymanWorkCrewId,
    { status: 'ACTIVE' },
    tx,
  );
  return {
    lockedScheduleId: lockedSchedule.id,
    compositionId: compositionInTx.id,
    vendorAssignmentId: compositionInTx.vendorAssignmentId,
    workOrderStatus: lockedWorkOrder.status,
    handymanWorkCrewId: lockedCrew.id,
    members,
    buildingId: lockedWorkOrder.buildingId,
    visitSequence: lockedVisit.visitSequence,
  };
}

/* ------------------------------------------------------------------ */
/* Convergent results                                                   */
/* ------------------------------------------------------------------ */

async function convergentResult(
  record: HandymanVisitArrivalRecord,
): Promise<HandymanVisitArrivalCommandResult> {
  const presence =
    record.verificationResult === 'VERIFIED'
      ? (
          await handymanVisitPresenceRepository.listByVisitId(
            record.handymanServiceVisitId,
          )
        ).map(toPublicHandymanVisitPresence)
      : [];
  return {
    arrival: toPublicHandymanVisitArrival(record),
    presence,
    converged: true,
  };
}

/** Outside-tx idempotency fast path (the CR-HM-BE-01 convention). */
async function convergeIdempotentReplay(
  clientId: string,
  idempotencyKey: string,
  fingerprint: string,
): Promise<HandymanVisitArrivalCommandResult | null> {
  const existing = await handymanVisitArrivalRepository.findByIdempotencyKey(
    clientId,
    idempotencyKey,
  );
  if (!existing) {
    return null;
  }
  if (existing.idempotencyFingerprint !== fingerprint) {
    throw handymanVisitArrivalIdempotencyConflictError();
  }
  return convergentResult(existing);
}

/** Once VERIFIED, the fact is established: every later command converges. */
async function convergeExistingVerified(
  visitId: string,
): Promise<HandymanVisitArrivalCommandResult | null> {
  const verified = await handymanVisitArrivalRepository.findVerifiedByVisitId(
    visitId,
  );
  if (!verified) {
    return null;
  }
  return convergentResult(verified);
}

/* ------------------------------------------------------------------ */
/* Shared transactional finalize                                        */
/* ------------------------------------------------------------------ */

type FinalizeArrivalParams = {
  visitId: string;
  clientId: string;
  chain: ArrivalChainContext;
  actorUserId: string;
  idempotencyKey: string;
  fingerprint: string;
  attempt: Omit<
    NewHandymanVisitArrival,
    'clientId' | 'handymanServiceVisitId' | 'recordedByUserId' | 'idempotencyKey' | 'idempotencyFingerprint'
  >;
};

async function finalizeArrival(
  params: FinalizeArrivalParams,
): Promise<HandymanVisitArrivalCommandResult> {
  const { visitId, clientId, chain, actorUserId, idempotencyKey, fingerprint } =
    params;

  const outcome = await withTransaction(async (tx) => {
    // 1. The visit-row lock: single-winner serialization per visit (and the
    //    head of the Run-2 lock-order family).
    const lockedVisit = await handymanServiceVisitRepository.lockVisitById(
      visitId,
      tx,
    );
    if (!lockedVisit) {
      throw handymanServiceVisitNotFoundError();
    }

    // 2. Decisive idempotency re-check UNDER the lock.
    const existingByKey =
      await handymanVisitArrivalRepository.findByIdempotencyKey(
        clientId,
        idempotencyKey,
        tx,
      );
    if (existingByKey) {
      if (existingByKey.idempotencyFingerprint !== fingerprint) {
        throw handymanVisitArrivalIdempotencyConflictError();
      }
      return { record: existingByKey, created: false };
    }

    // 3. Decisive already-VERIFIED convergence UNDER the lock.
    const verifiedInTx =
      await handymanVisitArrivalRepository.findVerifiedByVisitId(visitId, tx);
    if (verifiedInTx) {
      return { record: verifiedInTx, created: false };
    }

    // 4. Full §6 revalidation under the locks (Run-2 order verbatim).
    const locked = await reassertArrivalContextInTx(visitId, chain, tx);

    // 5. The immutable attempt insert (structural backstops converge).
    let insertResult;
    try {
      insertResult = await handymanVisitArrivalRepository.create(
        {
          ...params.attempt,
          clientId,
          handymanServiceVisitId: visitId,
          recordedByUserId: actorUserId,
          idempotencyKey,
          idempotencyFingerprint: fingerprint,
        },
        tx,
      );
    } catch (error) {
      const constraint = uniqueViolationConstraint(error);
      if (constraint === ARRIVALS_ONE_VERIFIED) {
        const winner =
          await handymanVisitArrivalRepository.findVerifiedByVisitId(
            visitId,
            tx,
          );
        if (winner) {
          return { record: winner, created: false };
        }
        throw handymanVisitArrivalStateInvalidError();
      }
      if (constraint === ARRIVALS_CLIENT_IDEMPOTENCY) {
        const winner =
          await handymanVisitArrivalRepository.findByIdempotencyKey(
            clientId,
            idempotencyKey,
            tx,
          );
        if (winner) {
          if (winner.idempotencyFingerprint !== fingerprint) {
            throw handymanVisitArrivalIdempotencyConflictError();
          }
          return { record: winner, created: false };
        }
        throw handymanVisitArrivalStateInvalidError();
      }
      throw error;
    }
    if (!insertResult.created) {
      // ON CONFLICT DO NOTHING resolved to a concurrent winner's row.
      if (insertResult.record.idempotencyFingerprint !== fingerprint) {
        throw handymanVisitArrivalIdempotencyConflictError();
      }
      return { record: insertResult.record, created: false };
    }

    const record = insertResult.record;

    // 6. The crew presence snapshot — SAME transaction as the VERIFIED
    //    arrival (if this fails, the arrival rolls back with it).
    if (record.verificationResult === 'VERIFIED') {
      await handymanVisitPresenceRepository.createSnapshot(
        locked.members.map((member) => ({
          clientId,
          handymanServiceVisitId: visitId,
          handymanVisitArrivalId: record.id,
          handymanJobAssignmentId: locked.compositionId,
          handymanWorkCrewId: locked.handymanWorkCrewId,
          vendorWorkforceBindingId: member.vendorWorkforceBindingId,
          crewRole: member.crewRole,
        })),
        tx,
      );
    }

    // 7. Audit — IDs and decision facts only (never coordinates, distance,
    //    free-text reasons or any person data).
    const metadata: Record<string, unknown> = {
      handymanJobId: chain.jobContext.job.id,
      visitSequence: locked.visitSequence,
      handymanServiceVisitScheduleId: locked.lockedScheduleId,
      verificationMethod: record.verificationMethod,
      verificationResult: record.verificationResult,
      handymanWorkCrewId: locked.handymanWorkCrewId,
    };
    if (record.failureReason) {
      metadata.failureReason = record.failureReason;
    }
    if (record.buildingConfigurationId) {
      metadata.buildingConfigurationId = record.buildingConfigurationId;
    }
    if (record.configurationVersionId) {
      metadata.configurationVersionId = record.configurationVersionId;
    }
    await recordOperationalEvent(
      {
        clientId,
        eventType: 'HANDYMAN_VISIT_ARRIVAL_RECORDED',
        entityType: 'HANDYMAN_VISIT_ARRIVAL',
        entityId: record.id,
        actorUserId,
        buildingId: locked.buildingId,
        summary:
          record.verificationMethod === 'ASSISTED'
            ? 'Handyman visit arrival recorded via assisted verification'
            : 'Handyman visit arrival recorded',
        metadata,
      },
      tx,
    );
    return { record, created: true };
  });

  if (!outcome.created) {
    return convergentResult(outcome.record);
  }
  const presence =
    outcome.record.verificationResult === 'VERIFIED'
      ? (
          await handymanVisitPresenceRepository.listByVisitId(visitId)
        ).map(toPublicHandymanVisitPresence)
      : [];
  return {
    arrival: toPublicHandymanVisitArrival(outcome.record),
    presence,
    converged: false,
  };
}

/* ------------------------------------------------------------------ */
/* GPS ARRIVAL (field action by the authenticated Lead Worker)         */
/* ------------------------------------------------------------------ */

/**
 * Records one GPS arrival attempt for the visit. The client supplies
 * evidence facts only (claimed coordinates/accuracy/occurrence time +
 * idempotency key); the SERVER resolves the canonical building, the ACTIVE
 * activated policy and decides VERIFIED/FAILED with an owned reason and
 * exact provenance. A FAILED decision is a recorded attempt, not an error;
 * guard failures (visit/schedule/job/composition/crew/lead chain) throw
 * their owning errors and record nothing.
 */
export async function recordGpsHandymanVisitArrival(
  visitId: string,
  input: RecordGpsArrivalInput,
  actorUserId: string,
): Promise<HandymanVisitArrivalCommandResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const occurredAt = coerceOccurredAt(input.occurredAt);

  const visit = await requireVisitForArrival(visitId);
  const jobContext = await loadFieldJobContext(visit.handymanJobId);
  const chain = await requireArrivalChain(jobContext);
  // Field authorization: the governed lead chain IS the access proof.
  await requireLeadActorForCrew(chain.handymanWorkCrewId, actorUserId);
  await requireActiveScheduleForArrival(visit.id);
  // Pool-level crew-chain fast fail (decisive re-assertion happens in tx).
  await requireOperationalCrewChain(
    chain.handymanWorkCrewId,
    chain.handymanProviderId,
    chain.vendorId,
    jobContext.job.clientId,
    getPool(),
    false,
  );

  const claim: GpsArrivalClaim = {
    latitude: input.latitude,
    longitude: input.longitude,
    accuracyMeters: input.accuracyMeters ?? null,
  };
  const fingerprint = computeArrivalFingerprint({
    handymanServiceVisitId: visit.id,
    verificationMethod: 'GPS',
    recordedByUserId: actorUserId,
    latitude: claim.latitude,
    longitude: claim.longitude,
    accuracyMeters: claim.accuracyMeters,
    occurredAt,
    assistedReason: null,
  });

  const replay = await convergeIdempotentReplay(
    visit.clientId,
    idempotencyKey,
    fingerprint,
  );
  if (replay) {
    return replay;
  }
  const converged = await convergeExistingVerified(visit.id);
  if (converged) {
    return converged;
  }

  // Server-side policy resolution + deterministic decision (provenance is
  // pinned to exactly what was resolved here — the CR-HM-BE-06 doctrine:
  // the client never decides, and absent/invalid policy is fail-closed).
  const resolution: ArrivalPolicyResolution =
    await resolveArrivalVerificationPolicy(jobContext.workOrder.buildingId);
  const decision = decideGpsArrival(resolution, claim);

  return finalizeArrival({
    visitId: visit.id,
    clientId: visit.clientId,
    chain,
    actorUserId,
    idempotencyKey,
    fingerprint,
    attempt: {
      verificationMethod: 'GPS',
      verificationResult: decision.result,
      occurredAt,
      latitude: decision.latitude,
      longitude: decision.longitude,
      accuracyMeters: decision.accuracyMeters,
      distanceMeters: decision.distanceMeters,
      buildingConfigurationId: decision.buildingConfigurationId,
      configurationVersionId: decision.configurationVersionId,
      assistedReason: null,
      failureReason: decision.failureReason,
    },
  });
}

/* ------------------------------------------------------------------ */
/* ASSISTED ARRIVAL (provenance-bearing staff override)                */
/* ------------------------------------------------------------------ */

/**
 * Records an ASSISTED arrival: an explicit staff override with a mandatory
 * non-empty reason and full recorder attribution — never fake GPS (no
 * coordinates, accuracy, distance or policy provenance is stored) and never
 * a rewrite of prior FAILED attempts. Deliberately NOT policy-gated:
 * ASSISTED is the governed fallback exactly when GPS verification is
 * unavailable fail-closed. If the visit already has a VERIFIED arrival, the
 * command converges onto it — a second VERIFIED arrival is never created.
 */
export async function recordAssistedHandymanVisitArrival(
  visitId: string,
  input: RecordAssistedArrivalInput,
  actorUserId: string,
): Promise<HandymanVisitArrivalCommandResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const occurredAt = coerceOccurredAt(input.occurredAt);
  if (
    typeof input.assistedReason !== 'string' ||
    input.assistedReason.trim() === ''
  ) {
    throw handymanVisitArrivalAssistedReasonRequiredError();
  }

  const visit = await requireVisitForArrival(visitId);
  // Staff path: the EXISTING BE-05 visit-management access idiom (client
  // scope asserted through the recorder's context access).
  const jobContext = await loadJobContext(visit.handymanJobId, actorUserId);
  const chain = await requireArrivalChain(jobContext);
  await requireActiveScheduleForArrival(visit.id);
  await requireOperationalCrewChain(
    chain.handymanWorkCrewId,
    chain.handymanProviderId,
    chain.vendorId,
    jobContext.job.clientId,
    getPool(),
    false,
  );

  const fingerprint = computeArrivalFingerprint({
    handymanServiceVisitId: visit.id,
    verificationMethod: 'ASSISTED',
    recordedByUserId: actorUserId,
    occurredAt,
    assistedReason: input.assistedReason,
  });

  const replay = await convergeIdempotentReplay(
    visit.clientId,
    idempotencyKey,
    fingerprint,
  );
  if (replay) {
    return replay;
  }
  const converged = await convergeExistingVerified(visit.id);
  if (converged) {
    return converged;
  }

  return finalizeArrival({
    visitId: visit.id,
    clientId: visit.clientId,
    chain,
    actorUserId,
    idempotencyKey,
    fingerprint,
    attempt: {
      verificationMethod: 'ASSISTED',
      verificationResult: 'VERIFIED',
      occurredAt,
      latitude: null,
      longitude: null,
      accuracyMeters: null,
      distanceMeters: null,
      buildingConfigurationId: null,
      configurationVersionId: null,
      assistedReason: input.assistedReason,
      failureReason: null,
    },
  });
}

/* ------------------------------------------------------------------ */
/* Run-3 HTTP surface — gated arrival-history read                     */
/* ------------------------------------------------------------------ */

/**
 * CR-HM-BE-06 RUN 3 — arrival attempt history of one visit, oldest first.
 * A THIN READ over the existing repository + public projection: no new
 * domain rule, no mutation, no event. Access is the shared field-execution
 * read scope (staff client access, an involved recorder, or the current
 * composition's Lead Worker). Privacy stays on the Run-1 projection: raw
 * claimed coordinates, accuracy, computed distance and idempotency keys
 * live on the evidence rows and are NEVER part of this read model.
 */
export async function listHandymanVisitArrivalsByVisit(
  visitId: string,
  actorUserId: string,
): Promise<PublicHandymanVisitArrival[]> {
  const visit = await requireVisitForArrival(visitId);
  const rows = await handymanVisitArrivalRepository.listByVisitId(visitId);
  await assertHandymanVisitExecutionReadAccess(
    visit,
    actorUserId,
    rows.map((row) => row.recordedByUserId),
  );
  return rows.map(toPublicHandymanVisitArrival);
}

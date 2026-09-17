import { getPool, withTransaction } from '../../database';
import { AppError } from '../../shared/errors';
import { recordOperationalEvent } from '../operational-events';
import {
  resolveVendorWorkPermitReadiness,
  type VendorWorkPermitReadiness,
} from '../work-permit-readiness';
import { workOrderNotFoundError } from '../work-orders';
import { handymanProviderRepository } from '../handyman-providers';
import { handymanWorkCrewRepository } from '../handyman-work-crews';
import {
  handymanJobAssignmentStateInvalidError,
  handymanJobNotAssignedError,
  handymanJobNotFoundError,
} from './handyman-job.errors';
import { handymanJobRepository } from './handyman-job.repository';
import {
  assertPreExecutionWorkOrder,
  isPreExecutionWorkOrderStatus,
  loadJobContext,
  requireEligibleProviderForJob,
  requireOperationalCrewChain,
  type JobContext,
} from './handyman-job.service';
import {
  handymanServiceVisitCrewConflictError,
  handymanServiceVisitNotFoundError,
  handymanServiceVisitNotSchedulableError,
  handymanServiceVisitScheduleNotFoundError,
  handymanServiceVisitScheduleStateInvalidError,
  handymanServiceVisitSequenceConflictError,
  handymanServiceVisitWindowInvalidError,
  handymanServiceVisitWorkerConflictError,
} from './handyman-service-visit.errors';
import { handymanServiceVisitRepository } from './handyman-service-visit.repository';
import type {
  CreateHandymanServiceVisitInput,
  HandymanServiceVisitCancellationResult,
  HandymanServiceVisitCreationResult,
  HandymanServiceVisitExecutionReadiness,
  HandymanServiceVisitRecord,
  HandymanServiceVisitRescheduleResult,
  HandymanServiceVisitScheduleRecord,
  HandymanServiceVisitView,
  PublicHandymanServiceVisit,
  PublicHandymanServiceVisitSchedule,
  RescheduleHandymanServiceVisitInput,
} from './handyman-service-visit.types';

/**
 * CR-HM-BE-05 RUN 2 — Handyman service visit scheduling authority.
 *
 * Composes existing foundations; duplicates none of their rules:
 * - Visit identity is minimal (occurrence + server-side sequence). Provider
 *   and crew are NEVER copied onto visits/schedules — they resolve from the
 *   job's ACTIVE Run-1 composition at TIME OF USE.
 * - Schedule windows are versioned rows: reschedule closes ACTIVE →
 *   SUPERSEDED and inserts a new ACTIVE row in the SAME transaction (the old
 *   window is never mutated); cancel closes ACTIVE → CANCELLED. Exactly one
 *   ACTIVE window per visit is a partial unique index; history is append-only.
 * - Schedule-time revalidation reuses the Run-1 seams verbatim: job context
 *   + BE-08 pre-execution window (OPEN/ASSIGNED), provider chain (CR-HM-BE-02
 *   designation, BE-06A vendor, BE-06D relationship, BE-06E/BE-02 capability
 *   eligibility for EVERY ACTIVE governed request service), and crew chain
 *   (CR-HM-BE-04 aggregate + BE-06F/BE-03C worker chain for the lead and
 *   every ACTIVE member).
 * - Temporal conflicts (discharging CR-HM-BE-04 P3 #3) use the repository's
 *   established half-open tstzrange '[)' interval idiom: SAME assigned crew
 *   on another job, or ANY shared worker (by vendor workforce binding id)
 *   through another crew on another job. Back-to-back windows are allowed;
 *   SUPERSEDED/CANCELLED windows and the schedule being replaced are
 *   ignored; membership alone is never rejected — only temporal overlap.
 * - Permit readiness REUSES the existing BE-15D authority unchanged
 *   (`resolveVendorWorkPermitReadiness` over the vendor work resolved from
 *   the ACTIVE composition): READY/NOT_READY/EXPIRED/NOT_REQUIRED semantics,
 *   including zero-rows = NOT_REQUIRED, stay owned by BE-15D. NO Handyman
 *   permit table, no permit lifecycle vocabulary here, and no invented rule
 *   that crew members must appear on permits.
 *
 * CONCURRENCY / DEADLOCK FREEDOM (§7 — no advisory locks, no distributed
 * locking): the authoritative conflict check runs INSIDE the write
 * transaction under a deterministic row-lock order:
 *
 *   1. the visit row (reschedule/cancel only; FOR UPDATE),
 *   2. the job row (handyman_jobs FOR UPDATE — the Run-1 per-job
 *      serialization point; also makes visit_sequence max+1 race-safe),
 *   3. the work order row (FOR UPDATE, pre-execution re-assertion),
 *   4. the assigned crew row (CR-HM-BE-04 lockById FOR UPDATE),
 *   5. the crew's ACTIVE worker binding rows in ASCENDING binding id order
 *      (CR-HM-BE-04 lockWorkerCandidate — `FOR UPDATE OF b`, binding rows
 *      only, no join-graph locks).
 *
 * Two commands can only conflict temporally when they share the crew or at
 * least one worker binding; any shared resource is acquired at step 4/5 in
 * the SAME global order (crew row before bindings; bindings sorted), so a
 * wait cycle is impossible: whichever command holds the shared crew/binding
 * lock first completes or rolls back before the other re-runs its conflict
 * scan under the lock. Create never locks an existing visit row and no path
 * acquires a visit lock while holding the job lock, so the visit→job prefix
 * cannot cycle either. The one-ACTIVE-per-visit partial unique index and the
 * (job, sequence) unique constraint remain the structural backstops.
 *
 * Boundary: this module NEVER transitions the work order beyond the Run-1
 * OPEN→ASSIGNED seam, NEVER starts/completes vendor work, and creates no
 * arrival/check-in/session records. The execution-readiness assessment is a
 * pure read (no audit event — the repository does not audit reads).
 *
 * Audit: HANDYMAN_SERVICE_VISIT_SCHEDULED / _RESCHEDULED /
 * _SCHEDULE_CANCELLED with IDs, sequence, schedule IDs, planned timestamps,
 * and status transitions only — never customer/worker PII.
 */

const UNIQUE_VIOLATION = '23505';
const VISITS_JOB_SEQUENCE_UNIQUE = 'handyman_service_visits_job_sequence_unique';
const SCHEDULES_ONE_ACTIVE =
  'handyman_service_visit_schedules_one_active_per_visit';

export function toPublicHandymanServiceVisit(
  record: HandymanServiceVisitRecord,
): PublicHandymanServiceVisit {
  return {
    id: record.id,
    clientId: record.clientId,
    handymanJobId: record.handymanJobId,
    visitSequence: record.visitSequence,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicHandymanServiceVisitSchedule(
  record: HandymanServiceVisitScheduleRecord,
): PublicHandymanServiceVisitSchedule {
  return {
    id: record.id,
    clientId: record.clientId,
    handymanServiceVisitId: record.handymanServiceVisitId,
    plannedStartAt: record.plannedStartAt.toISOString(),
    plannedEndAt: record.plannedEndAt.toISOString(),
    status: record.status,
    createdByUserId: record.createdByUserId,
    supersededAt: record.supersededAt
      ? record.supersededAt.toISOString()
      : null,
    supersededByUserId: record.supersededByUserId,
    cancelledAt: record.cancelledAt ? record.cancelledAt.toISOString() : null,
    cancelledByUserId: record.cancelledByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
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

function assertPlannedWindow(plannedStartAt: Date, plannedEndAt: Date): void {
  if (
    !(plannedStartAt instanceof Date) ||
    Number.isNaN(plannedStartAt.getTime()) ||
    !(plannedEndAt instanceof Date) ||
    Number.isNaN(plannedEndAt.getTime()) ||
    plannedEndAt.getTime() <= plannedStartAt.getTime()
  ) {
    throw handymanServiceVisitWindowInvalidError();
  }
}

/**
 * The scheduling context, resolved SERVER-SIDE from business facts only:
 * job context (client scope + canonical building/client identity), the
 * Run-1 ACTIVE composition, and the provider/crew identities it names. The
 * caller never supplies client, provider, vendor, crew, or work-order ids.
 */
type SchedulingContext = {
  jobContext: JobContext;
  compositionId: string;
  vendorAssignmentId: string;
  handymanProviderId: string;
  vendorId: string;
  handymanWorkCrewId: string;
};

async function requireSchedulingContext(
  jobContext: JobContext,
): Promise<SchedulingContext> {
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
    // A composition without its BE-15A row cannot exist (Run-1 atomicity);
    // reaching this branch means the composition drifted — fail closed.
    throw handymanJobAssignmentStateInvalidError(
      'The active handyman job assignment lost its vendor assignment.',
    );
  }
  // The crew names the provider (CR-HM-BE-04 invariant: a crew belongs to
  // exactly one designation), and the Run-1 composition guaranteed crew ↔
  // provider ↔ vendor coherence at write time; re-assert it at time of use.
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

/** Full time-of-use revalidation (§4) + authoritative in-transaction
 * conflict scans (§5/§6). Returns the sorted ACTIVE worker binding ids. */
async function revalidateAndScanConflicts(
  context: SchedulingContext,
  window: { plannedStartAt: Date; plannedEndAt: Date },
  actorUserId: string,
  excludeScheduleId: string | null,
): Promise<string[]> {
  const { jobContext } = context;
  assertPreExecutionWorkOrder(jobContext.workOrder.status);
  await requireEligibleProviderForJob(
    jobContext,
    context.handymanProviderId,
    actorUserId,
  );
  // Pool-level prevalidation (fast fail); the transaction re-asserts the
  // stateful facts under locks — the Run-1 doctrine.
  const bindingIds = await requireOperationalCrewChain(
    context.handymanWorkCrewId,
    context.handymanProviderId,
    context.vendorId,
    jobContext.job.clientId,
    getPool(),
    false,
  );
  const crewConflict = await handymanServiceVisitRepository.findCrewScheduleConflict(
    {
      handymanWorkCrewId: context.handymanWorkCrewId,
      handymanJobId: jobContext.job.id,
      plannedStartAt: window.plannedStartAt,
      plannedEndAt: window.plannedEndAt,
      excludeScheduleId,
    },
  );
  if (crewConflict) {
    throw handymanServiceVisitCrewConflictError({
      conflictingHandymanServiceVisitId: crewConflict.visitId,
      conflictingScheduleId: crewConflict.scheduleId,
      handymanWorkCrewId: context.handymanWorkCrewId,
    });
  }
  const workerConflict =
    await handymanServiceVisitRepository.findWorkerScheduleConflict({
      vendorWorkforceBindingIds: bindingIds,
      handymanJobId: jobContext.job.id,
      plannedStartAt: window.plannedStartAt,
      plannedEndAt: window.plannedEndAt,
      excludeScheduleId,
    });
  if (workerConflict) {
    throw handymanServiceVisitWorkerConflictError({
      conflictingHandymanServiceVisitId: workerConflict.visitId,
      conflictingScheduleId: workerConflict.scheduleId,
      vendorWorkforceBindingId: workerConflict.bindingId ?? '',
    });
  }
  return bindingIds;
}

/* ------------------------------------------------------------------ */
/* CREATE VISIT + INITIAL SCHEDULE (one atomic governed command)       */
/* ------------------------------------------------------------------ */

/**
 * Creates a visit occurrence and its FIRST ACTIVE schedule window in ONE
 * transaction. Business facts in, everything else resolved server-side.
 * Requires an ACTIVE Run-1 job assignment and revalidates the full
 * job/provider/crew authority at time of use.
 */
export async function createHandymanServiceVisit(
  input: CreateHandymanServiceVisitInput,
  actorUserId: string,
): Promise<HandymanServiceVisitCreationResult> {
  assertPlannedWindow(input.plannedStartAt, input.plannedEndAt);
  const jobContext = await loadJobContext(input.handymanJobId, actorUserId);
  const context = await requireSchedulingContext(jobContext);
  await revalidateAndScanConflicts(
    context,
    { plannedStartAt: input.plannedStartAt, plannedEndAt: input.plannedEndAt },
    actorUserId,
    null,
  );

  const created = await withTransaction(async (tx) => {
    // Lock order (§7): job → work order → crew → sorted worker bindings.
    const lockedJob = await handymanJobRepository.lockById(
      jobContext.job.id,
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
    assertPreExecutionWorkOrder(lockedWorkOrder.status);

    const compositionInTx = await handymanJobRepository.findActiveByJobId(
      lockedJob.id,
      tx,
    );
    if (!compositionInTx) {
      throw handymanJobNotAssignedError();
    }
    if (compositionInTx.id !== context.compositionId) {
      // A concurrent reassignment changed the crew this command validated
      // and scanned conflicts against — stale context, never guess.
      throw handymanJobAssignmentStateInvalidError(
        'The active handyman job assignment changed during this operation.',
      );
    }

    const lockedCrew = await handymanWorkCrewRepository.lockById(
      context.handymanWorkCrewId,
      tx,
    );
    if (!lockedCrew || lockedCrew.status !== 'ACTIVE') {
      throw handymanJobAssignmentStateInvalidError(
        'The assigned crew is no longer active.',
      );
    }
    const designationInTx = await handymanJobRepository.lockProviderDesignation(
      context.handymanProviderId,
      tx,
    );
    if (
      !designationInTx ||
      designationInTx.status !== 'ACTIVE' ||
      designationInTx.vendorId !== context.vendorId
    ) {
      throw handymanJobAssignmentStateInvalidError(
        'The assigned provider designation is no longer assignable.',
      );
    }
    const vendorInTx = await handymanJobRepository.lockVendor(
      context.vendorId,
      tx,
    );
    if (!vendorInTx || vendorInTx.status !== 'ACTIVE') {
      throw handymanJobAssignmentStateInvalidError(
        'The assigned vendor is no longer active.',
      );
    }
    const relationshipInTx =
      await handymanJobRepository.findActiveVendorBuildingRelationship(
        context.vendorId,
        lockedWorkOrder.buildingId,
        tx,
      );
    if (!relationshipInTx) {
      throw handymanJobAssignmentStateInvalidError(
        'The vendor-building relationship of the assignment is no longer active.',
      );
    }
    // Re-runs the CR04 lead + worker chain with binding locks in sorted
    // order (deadlock-free acquisition) — and yields the binding ids.
    const bindingIds = await requireOperationalCrewChain(
      context.handymanWorkCrewId,
      context.handymanProviderId,
      context.vendorId,
      lockedJob.clientId,
      tx,
      false,
    );

    // Authoritative conflict scans UNDER the locks (the pool-level pre-check
    // is fast-fail only; these decide).
    const crewConflict =
      await handymanServiceVisitRepository.findCrewScheduleConflict(
        {
          handymanWorkCrewId: context.handymanWorkCrewId,
          handymanJobId: lockedJob.id,
          plannedStartAt: input.plannedStartAt,
          plannedEndAt: input.plannedEndAt,
          excludeScheduleId: null,
        },
        tx,
      );
    if (crewConflict) {
      throw handymanServiceVisitCrewConflictError({
        conflictingHandymanServiceVisitId: crewConflict.visitId,
        conflictingScheduleId: crewConflict.scheduleId,
        handymanWorkCrewId: context.handymanWorkCrewId,
      });
    }
    const workerConflict =
      await handymanServiceVisitRepository.findWorkerScheduleConflict(
        {
          vendorWorkforceBindingIds: bindingIds,
          handymanJobId: lockedJob.id,
          plannedStartAt: input.plannedStartAt,
          plannedEndAt: input.plannedEndAt,
          excludeScheduleId: null,
        },
        tx,
      );
    if (workerConflict) {
      throw handymanServiceVisitWorkerConflictError({
        conflictingHandymanServiceVisitId: workerConflict.visitId,
        conflictingScheduleId: workerConflict.scheduleId,
        vendorWorkforceBindingId: workerConflict.bindingId ?? '',
      });
    }

    // Server-side sequence under the job-row lock; the unique constraint is
    // the structural backstop.
    const visitSequence = await handymanServiceVisitRepository.nextVisitSequence(
      lockedJob.id,
      tx,
    );
    let visit;
    try {
      visit = await handymanServiceVisitRepository.createVisit(
        {
          clientId: lockedJob.clientId,
          handymanJobId: lockedJob.id,
          visitSequence,
          createdByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (uniqueViolationConstraint(error) === VISITS_JOB_SEQUENCE_UNIQUE) {
        throw handymanServiceVisitSequenceConflictError();
      }
      throw error;
    }
    let schedule;
    try {
      schedule = await handymanServiceVisitRepository.createSchedule(
        {
          clientId: lockedJob.clientId,
          handymanServiceVisitId: visit.id,
          plannedStartAt: input.plannedStartAt,
          plannedEndAt: input.plannedEndAt,
          createdByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (uniqueViolationConstraint(error) === SCHEDULES_ONE_ACTIVE) {
        throw handymanServiceVisitScheduleStateInvalidError();
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: lockedJob.clientId,
        eventType: 'HANDYMAN_SERVICE_VISIT_SCHEDULED',
        entityType: 'HANDYMAN_SERVICE_VISIT',
        entityId: visit.id,
        actorUserId,
        buildingId: lockedWorkOrder.buildingId,
        summary: 'Handyman service visit scheduled',
        metadata: {
          handymanJobId: lockedJob.id,
          visitSequence: visit.visitSequence,
          handymanServiceVisitScheduleId: schedule.id,
          handymanWorkCrewId: context.handymanWorkCrewId,
          plannedStartAt: schedule.plannedStartAt.toISOString(),
          plannedEndAt: schedule.plannedEndAt.toISOString(),
          status: 'ACTIVE',
        },
      },
      tx,
    );
    return { visit, schedule };
  });

  return {
    visit: toPublicHandymanServiceVisit(created.visit),
    schedule: toPublicHandymanServiceVisitSchedule(created.schedule),
  };
}

/* ------------------------------------------------------------------ */
/* RESCHEDULE (versioned window replacement)                           */
/* ------------------------------------------------------------------ */

/**
 * Replaces the visit's ACTIVE window: guarded ACTIVE → SUPERSEDED plus the
 * new ACTIVE row in ONE transaction. The old time window is never mutated.
 * Conflict checks exclude the schedule being replaced (subsumed by the
 * same-job exclusion and stated explicitly). One winner under concurrency:
 * the guarded `WHERE status = 'ACTIVE'` closure makes a stale command a 409.
 */
export async function rescheduleHandymanServiceVisit(
  visitId: string,
  input: RescheduleHandymanServiceVisitInput,
  actorUserId: string,
): Promise<HandymanServiceVisitRescheduleResult> {
  assertPlannedWindow(input.plannedStartAt, input.plannedEndAt);
  const visit = await handymanServiceVisitRepository.findVisitById(visitId);
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  const jobContext = await loadJobContext(visit.handymanJobId, actorUserId);
  const context = await requireSchedulingContext(jobContext);
  const current =
    await handymanServiceVisitRepository.findActiveScheduleByVisitId(visit.id);
  if (!current) {
    throw handymanServiceVisitNotSchedulableError();
  }
  await revalidateAndScanConflicts(
    context,
    { plannedStartAt: input.plannedStartAt, plannedEndAt: input.plannedEndAt },
    actorUserId,
    current.id,
  );

  const result = await withTransaction(async (tx) => {
    // Lock order (§7): visit → job → work order → crew → sorted bindings.
    const lockedVisit = await handymanServiceVisitRepository.lockVisitById(
      visit.id,
      tx,
    );
    if (!lockedVisit) {
      throw handymanServiceVisitNotFoundError();
    }
    const lockedSchedule =
      await handymanServiceVisitRepository.lockActiveScheduleByVisitId(
        visit.id,
        tx,
      );
    if (!lockedSchedule) {
      throw handymanServiceVisitNotSchedulableError();
    }
    if (lockedSchedule.id !== current.id) {
      throw handymanServiceVisitScheduleStateInvalidError();
    }
    const lockedJob = await handymanJobRepository.lockById(
      jobContext.job.id,
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
    assertPreExecutionWorkOrder(lockedWorkOrder.status);

    const compositionInTx = await handymanJobRepository.findActiveByJobId(
      lockedJob.id,
      tx,
    );
    if (!compositionInTx) {
      throw handymanJobNotAssignedError();
    }
    if (compositionInTx.id !== context.compositionId) {
      throw handymanJobAssignmentStateInvalidError(
        'The active handyman job assignment changed during this operation.',
      );
    }
    const lockedCrew = await handymanWorkCrewRepository.lockById(
      context.handymanWorkCrewId,
      tx,
    );
    if (!lockedCrew || lockedCrew.status !== 'ACTIVE') {
      throw handymanJobAssignmentStateInvalidError(
        'The assigned crew is no longer active.',
      );
    }
    const designationInTx = await handymanJobRepository.lockProviderDesignation(
      context.handymanProviderId,
      tx,
    );
    if (
      !designationInTx ||
      designationInTx.status !== 'ACTIVE' ||
      designationInTx.vendorId !== context.vendorId
    ) {
      throw handymanJobAssignmentStateInvalidError(
        'The assigned provider designation is no longer assignable.',
      );
    }
    const vendorInTx = await handymanJobRepository.lockVendor(
      context.vendorId,
      tx,
    );
    if (!vendorInTx || vendorInTx.status !== 'ACTIVE') {
      throw handymanJobAssignmentStateInvalidError(
        'The assigned vendor is no longer active.',
      );
    }
    const relationshipInTx =
      await handymanJobRepository.findActiveVendorBuildingRelationship(
        context.vendorId,
        lockedWorkOrder.buildingId,
        tx,
      );
    if (!relationshipInTx) {
      throw handymanJobAssignmentStateInvalidError(
        'The vendor-building relationship of the assignment is no longer active.',
      );
    }
    const bindingIds = await requireOperationalCrewChain(
      context.handymanWorkCrewId,
      context.handymanProviderId,
      context.vendorId,
      lockedJob.clientId,
      tx,
      false,
    );

    const crewConflict =
      await handymanServiceVisitRepository.findCrewScheduleConflict(
        {
          handymanWorkCrewId: context.handymanWorkCrewId,
          handymanJobId: lockedJob.id,
          plannedStartAt: input.plannedStartAt,
          plannedEndAt: input.plannedEndAt,
          excludeScheduleId: lockedSchedule.id,
        },
        tx,
      );
    if (crewConflict) {
      throw handymanServiceVisitCrewConflictError({
        conflictingHandymanServiceVisitId: crewConflict.visitId,
        conflictingScheduleId: crewConflict.scheduleId,
        handymanWorkCrewId: context.handymanWorkCrewId,
      });
    }
    const workerConflict =
      await handymanServiceVisitRepository.findWorkerScheduleConflict(
        {
          vendorWorkforceBindingIds: bindingIds,
          handymanJobId: lockedJob.id,
          plannedStartAt: input.plannedStartAt,
          plannedEndAt: input.plannedEndAt,
          excludeScheduleId: lockedSchedule.id,
        },
        tx,
      );
    if (workerConflict) {
      throw handymanServiceVisitWorkerConflictError({
        conflictingHandymanServiceVisitId: workerConflict.visitId,
        conflictingScheduleId: workerConflict.scheduleId,
        vendorWorkforceBindingId: workerConflict.bindingId ?? '',
      });
    }

    // Guarded closure: a stale command can never overwrite the newer state.
    const superseded =
      await handymanServiceVisitRepository.supersedeActiveSchedule(
        lockedSchedule.id,
        actorUserId,
        tx,
      );
    if (!superseded) {
      throw handymanServiceVisitScheduleStateInvalidError();
    }
    let schedule;
    try {
      schedule = await handymanServiceVisitRepository.createSchedule(
        {
          clientId: lockedJob.clientId,
          handymanServiceVisitId: lockedVisit.id,
          plannedStartAt: input.plannedStartAt,
          plannedEndAt: input.plannedEndAt,
          createdByUserId: actorUserId,
        },
        tx,
      );
    } catch (error) {
      if (uniqueViolationConstraint(error) === SCHEDULES_ONE_ACTIVE) {
        throw handymanServiceVisitScheduleStateInvalidError();
      }
      throw error;
    }

    await recordOperationalEvent(
      {
        clientId: lockedJob.clientId,
        eventType: 'HANDYMAN_SERVICE_VISIT_RESCHEDULED',
        entityType: 'HANDYMAN_SERVICE_VISIT',
        entityId: lockedVisit.id,
        actorUserId,
        buildingId: lockedWorkOrder.buildingId,
        summary: 'Handyman service visit rescheduled',
        metadata: {
          handymanJobId: lockedJob.id,
          visitSequence: lockedVisit.visitSequence,
          previousHandymanServiceVisitScheduleId: superseded.id,
          handymanServiceVisitScheduleId: schedule.id,
          previousPlannedStartAt: superseded.plannedStartAt.toISOString(),
          previousPlannedEndAt: superseded.plannedEndAt.toISOString(),
          plannedStartAt: schedule.plannedStartAt.toISOString(),
          plannedEndAt: schedule.plannedEndAt.toISOString(),
          previousStatus: 'SUPERSEDED',
          status: 'ACTIVE',
        },
      },
      tx,
    );
    return { visit: lockedVisit, schedule, supersededScheduleId: superseded.id };
  });

  return {
    visit: toPublicHandymanServiceVisit(result.visit),
    schedule: toPublicHandymanServiceVisitSchedule(result.schedule),
    supersededScheduleId: result.supersededScheduleId,
  };
}

/* ------------------------------------------------------------------ */
/* CANCEL (smallest safe semantics — closes the ACTIVE window)         */
/* ------------------------------------------------------------------ */

/**
 * Cancels the visit's ACTIVE schedule window: guarded ACTIVE → CANCELLED,
 * visit identity/history retained, and the window is freed for future
 * scheduling (conflict scans only consider ACTIVE rows). This is NOT a work
 * order cancellation and never touches the request/quotation. Deliberately
 * ungated on the work-order state and the provider/crew chain: closing a
 * future window is always safe, even after execution has begun. A replay
 * onto an already-CANCELLED visit returns idempotently (the Run-1 replay
 * idiom); anything else without an ACTIVE window is a guarded 409.
 */
export async function cancelHandymanServiceVisitSchedule(
  visitId: string,
  actorUserId: string,
): Promise<HandymanServiceVisitCancellationResult> {
  const visit = await handymanServiceVisitRepository.findVisitById(visitId);
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  // Client data scope only (the Run-1 access idiom) — no chain revalidation:
  // cancellation creates no window and composes nothing.
  const jobContext = await loadJobContext(visit.handymanJobId, actorUserId);

  const existingActive =
    await handymanServiceVisitRepository.findActiveScheduleByVisitId(visit.id);
  if (!existingActive) {
    // Replay: the visit's window was already cancelled — return closed
    // evidence instead of failing (idempotent per the Run-1 replay idiom).
    const history = await handymanServiceVisitRepository.listSchedulesByVisitId(
      visit.id,
    );
    const cancelled = history.find((row) => row.status === 'CANCELLED');
    if (cancelled) {
      return {
        visit: toPublicHandymanServiceVisit(visit),
        cancelledScheduleId: cancelled.id,
        alreadyCancelled: true,
      };
    }
    throw handymanServiceVisitNotSchedulableError();
  }

  const result = await withTransaction(async (tx) => {
    const lockedVisit = await handymanServiceVisitRepository.lockVisitById(
      visit.id,
      tx,
    );
    if (!lockedVisit) {
      throw handymanServiceVisitNotFoundError();
    }
    const lockedSchedule =
      await handymanServiceVisitRepository.lockActiveScheduleByVisitId(
        visit.id,
        tx,
      );
    if (!lockedSchedule) {
      throw handymanServiceVisitScheduleStateInvalidError();
    }
    const cancelledRow =
      await handymanServiceVisitRepository.cancelActiveSchedule(
        lockedSchedule.id,
        actorUserId,
        tx,
      );
    if (!cancelledRow) {
      throw handymanServiceVisitScheduleStateInvalidError();
    }
    await recordOperationalEvent(
      {
        clientId: jobContext.job.clientId,
        eventType: 'HANDYMAN_SERVICE_VISIT_SCHEDULE_CANCELLED',
        entityType: 'HANDYMAN_SERVICE_VISIT',
        entityId: lockedVisit.id,
        actorUserId,
        buildingId: jobContext.workOrder.buildingId,
        summary: 'Handyman service visit schedule cancelled',
        metadata: {
          handymanJobId: lockedVisit.handymanJobId,
          visitSequence: lockedVisit.visitSequence,
          handymanServiceVisitScheduleId: cancelledRow.id,
          plannedStartAt: cancelledRow.plannedStartAt.toISOString(),
          plannedEndAt: cancelledRow.plannedEndAt.toISOString(),
          status: 'CANCELLED',
        },
      },
      tx,
    );
    return cancelledRow;
  });

  return {
    visit: toPublicHandymanServiceVisit(visit),
    cancelledScheduleId: result.id,
    alreadyCancelled: false,
  };
}

/* ------------------------------------------------------------------ */
/* EXECUTION-READY GATE (a pure readiness assessment)                  */
/* ------------------------------------------------------------------ */

/**
 * Answers: "Is this scheduled Handyman visit ready for later execution?"
 *
 * A READ-ONLY assessment — it never transitions the work order, never starts
 * the vendor work, and creates no check-in. Permit readiness is the EXISTING
 * BE-15D aggregate for the vendor work resolved from the ACTIVE composition
 * (zero readiness rows keep BE-15D's NOT_REQUIRED semantics — a missing row
 * never invents a permit requirement). Chain failures are captured as
 * check booleans (not thrown) so one call reports the full readiness picture;
 * structural failures (missing visit/job/composition/vendor work) still
 * throw their owning 404/409s.
 */
export async function assessHandymanServiceVisitExecutionReadiness(
  visitId: string,
  actorUserId: string,
): Promise<HandymanServiceVisitExecutionReadiness> {
  const visit = await handymanServiceVisitRepository.findVisitById(visitId);
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  const jobContext = await loadJobContext(visit.handymanJobId, actorUserId);
  return assessHandymanServiceVisitExecutionReadinessCore(
    visit,
    jobContext,
    actorUserId,
  );
}

/**
 * Injectable subreads for the readiness core (CR-HM-BE-06 Run 2 §11).
 *
 * The defaults ARE the existing BE-05 behavior (actor-gated BE-02/BE-15D
 * reads + the pre-execution work-order predicate). A governed PREAUTHORIZED
 * command chain — the Handyman Work Session start command, whose actor is a
 * field lead authorized by the BE-06 lead chain instead of a building
 * assignment — injects the access-neutral variants of the SAME rule
 * authorities and the execution-start work-order predicate. No checklist,
 * aggregation, or conflict/crew semantics are ever duplicated: this core
 * function stays the ONE semantic authority for execution readiness.
 */
export type ExecutionReadinessSubreads = {
  requireProviderEligibility: (
    jobContext: JobContext,
    handymanProviderId: string,
  ) => Promise<{ providerId: string; vendorId: string }>;
  resolvePermitReadiness: (
    vendorWorkId: string,
  ) => Promise<VendorWorkPermitReadiness>;
  isWorkOrderStartable: (workOrderStatus: string) => boolean;
};

export async function assessHandymanServiceVisitExecutionReadinessCore(
  visit: HandymanServiceVisitRecord,
  jobContext: JobContext,
  actorUserId: string,
  subreads: ExecutionReadinessSubreads = {
    requireProviderEligibility: (context, handymanProviderId) =>
      requireEligibleProviderForJob(context, handymanProviderId, actorUserId),
    resolvePermitReadiness: (vendorWorkId) =>
      resolveVendorWorkPermitReadiness(vendorWorkId, actorUserId),
    isWorkOrderStartable: (workOrderStatus) =>
      isPreExecutionWorkOrderStatus(workOrderStatus),
  },
): Promise<HandymanServiceVisitExecutionReadiness> {
  const activeSchedule =
    await handymanServiceVisitRepository.findActiveScheduleByVisitId(visit.id);

  const composition = await handymanJobRepository.findActiveByJobId(
    jobContext.job.id,
  );
  const hasActiveJobAssignment = composition !== null;

  // Resolve the vendor work through the composition (Run-1 atomicity means
  // the row exists; if it is missing, readiness is structurally false).
  let vendorWorkId = '';
  if (composition) {
    const vendorWork = await handymanJobRepository.findVendorWorkByAssignmentId(
      composition.vendorAssignmentId,
    );
    vendorWorkId = vendorWork ? vendorWork.id : '';
  }
  if (!vendorWorkId) {
    throw handymanJobNotAssignedError();
  }

  const workOrderPreExecution = subreads.isWorkOrderStartable(
    jobContext.workOrder.status,
  );

  // Provider/crew chain validity as booleans (owning-module errors become
  // failure signals; non-domain errors propagate).
  let providerChainValid = false;
  let crewChainValid = false;
  let bindingIds: string[] = [];
  let schedulingContext: SchedulingContext | null = null;
  if (hasActiveJobAssignment) {
    try {
      schedulingContext = await requireSchedulingContext(jobContext);
      await subreads.requireProviderEligibility(
        jobContext,
        schedulingContext.handymanProviderId,
      );
      providerChainValid = true;
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }
      providerChainValid = false;
    }
    if (schedulingContext) {
      try {
        bindingIds = await requireOperationalCrewChain(
          schedulingContext.handymanWorkCrewId,
          schedulingContext.handymanProviderId,
          schedulingContext.vendorId,
          jobContext.job.clientId,
          getPool(),
          false,
        );
        crewChainValid = true;
      } catch (error) {
        if (!(error instanceof AppError)) {
          throw error;
        }
        crewChainValid = false;
      }
    }
  }

  // Conflict re-check of the CURRENT ACTIVE window (defensive: the write
  // paths enforce this under locks; a conflict here means state changed
  // after scheduling, e.g. through another job's composition).
  let noScheduleConflict = true;
  if (activeSchedule && schedulingContext) {
    const crewConflict =
      await handymanServiceVisitRepository.findCrewScheduleConflict({
        handymanWorkCrewId: schedulingContext.handymanWorkCrewId,
        handymanJobId: jobContext.job.id,
        plannedStartAt: activeSchedule.plannedStartAt,
        plannedEndAt: activeSchedule.plannedEndAt,
        excludeScheduleId: activeSchedule.id,
      });
    const workerConflict = crewConflict
      ? null
      : await handymanServiceVisitRepository.findWorkerScheduleConflict({
          vendorWorkforceBindingIds: bindingIds,
          handymanJobId: jobContext.job.id,
          plannedStartAt: activeSchedule.plannedStartAt,
          plannedEndAt: activeSchedule.plannedEndAt,
          excludeScheduleId: activeSchedule.id,
        });
    noScheduleConflict = !crewConflict && !workerConflict;
  } else if (activeSchedule && !schedulingContext) {
    noScheduleConflict = false;
  }

  // BE-15D passthrough — readiness semantics (including zero rows =
  // NOT_REQUIRED) stay owned by BE-15D. No event: pure reads are not audited.
  const permitReadiness = await subreads.resolvePermitReadiness(vendorWorkId);

  const hasActiveSchedule = activeSchedule !== null;
  const ready =
    hasActiveSchedule &&
    workOrderPreExecution &&
    hasActiveJobAssignment &&
    providerChainValid &&
    crewChainValid &&
    noScheduleConflict &&
    permitReadiness.ready;

  return {
    handymanServiceVisitId: visit.id,
    handymanJobId: jobContext.job.id,
    workOrderId: jobContext.job.workOrderId,
    vendorWorkId,
    ready,
    checks: {
      hasActiveSchedule,
      workOrderPreExecution,
      hasActiveJobAssignment,
      providerChainValid,
      crewChainValid,
      noScheduleConflict,
      permitsReady: permitReadiness.ready,
    },
    activeSchedule: activeSchedule
      ? toPublicHandymanServiceVisitSchedule(activeSchedule)
      : null,
    permitReadiness,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** One visit with its current ACTIVE window, behind the client data scope. */
export async function getHandymanServiceVisitById(
  visitId: string,
  actorUserId: string,
): Promise<HandymanServiceVisitView> {
  const visit = await handymanServiceVisitRepository.findVisitById(visitId);
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  await loadJobContext(visit.handymanJobId, actorUserId);
  const activeSchedule =
    await handymanServiceVisitRepository.findActiveScheduleByVisitId(visit.id);
  return {
    visit: toPublicHandymanServiceVisit(visit),
    activeSchedule: activeSchedule
      ? toPublicHandymanServiceVisitSchedule(activeSchedule)
      : null,
  };
}

/** All visits of one job in sequence order, each with its ACTIVE window. */
export async function listHandymanServiceVisitsByJob(
  jobId: string,
  actorUserId: string,
): Promise<HandymanServiceVisitView[]> {
  const { job } = await loadJobContext(jobId, actorUserId);
  const visits = await handymanServiceVisitRepository.listVisitsByJob(job.id);
  const result: HandymanServiceVisitView[] = [];
  for (const visit of visits) {
    const activeSchedule =
      await handymanServiceVisitRepository.findActiveScheduleByVisitId(
        visit.id,
      );
    result.push({
      visit: toPublicHandymanServiceVisit(visit),
      activeSchedule: activeSchedule
        ? toPublicHandymanServiceVisitSchedule(activeSchedule)
        : null,
    });
  }
  return result;
}

/** Full append-only schedule history of one visit (oldest first). */
export async function listHandymanServiceVisitSchedules(
  visitId: string,
  actorUserId: string,
): Promise<PublicHandymanServiceVisitSchedule[]> {
  const visit = await handymanServiceVisitRepository.findVisitById(visitId);
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  await loadJobContext(visit.handymanJobId, actorUserId);
  const records =
    await handymanServiceVisitRepository.listSchedulesByVisitId(visit.id);
  return records.map(toPublicHandymanServiceVisitSchedule);
}

/** One schedule row by id (history inspection), behind the client scope. */
export async function getHandymanServiceVisitScheduleById(
  scheduleId: string,
  actorUserId: string,
): Promise<PublicHandymanServiceVisitSchedule> {
  const schedule =
    await handymanServiceVisitRepository.findScheduleById(scheduleId);
  if (!schedule) {
    throw handymanServiceVisitScheduleNotFoundError();
  }
  const visit = await handymanServiceVisitRepository.findVisitById(
    schedule.handymanServiceVisitId,
  );
  if (!visit) {
    throw handymanServiceVisitNotFoundError();
  }
  await loadJobContext(visit.handymanJobId, actorUserId);
  return toPublicHandymanServiceVisitSchedule(schedule);
}

export const handymanServiceVisitService = {
  assessHandymanServiceVisitExecutionReadiness,
  cancelHandymanServiceVisitSchedule,
  createHandymanServiceVisit,
  getHandymanServiceVisitById,
  getHandymanServiceVisitScheduleById,
  listHandymanServiceVisitSchedules,
  listHandymanServiceVisitsByJob,
  rescheduleHandymanServiceVisit,
  toPublicHandymanServiceVisit,
  toPublicHandymanServiceVisitSchedule,
};

import type { PoolClient } from 'pg';
import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import { handymanScopeAssignmentRepository } from '../handyman-scope-assignments';
import { hasApprovedScopeQuotation } from '../handyman-scope-assignments/handyman-scope-quotation-authority';
import { hasRequiredDispatchPayment } from './handyman-dispatch-payment';
import { lockReworkDispatchLineage, readReworkDispatchBasis } from './handyman-rework-dispatch';
import { assertWarrantyReworkOperations } from '../handyman-service-warranty-reworks/handyman-warranty-rework-authority';
import { handymanPermitReadinessRepository } from '../handyman-scheduling/handyman-permit-readiness.repository';
import { handymanUnitAccessReadinessRepository } from '../handyman-scheduling/handyman-unit-access.repository';
import {
  handymanDispatchNotReadyError,
  handymanDispatchReleaseConflictError,
  handymanDispatchReleaseNotFoundError,
} from './handyman-dispatch.errors';
import { handymanDispatchRepository } from './handyman-dispatch.repository';
import { assessHandymanBmClearance, readBmCrewBinding, readBmWorkBinding } from './handyman-bm-clearance';
import type { HandymanBmClearanceAssessment } from './handyman-bm-clearance';
import type {
  HandymanDispatchReadinessCheck,
  HandymanDispatchReadinessReport,
  PublicHandymanDispatchRelease,
  ReleaseHandymanDispatchInput,
} from './handyman-dispatch.types';

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw new Error(`HANDYMAN_DISPATCH_INVALID_UUID:${field}`);
  }
  return raw;
}

function toPublic(
  record: Awaited<
    ReturnType<typeof handymanDispatchRepository.findActiveByScope>
  > & object,
): PublicHandymanDispatchRelease {
  return {
    ...record,
    releasedAt: record.releasedAt.toISOString(),
    cancelledAt: record.cancelledAt ? record.cancelledAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

type DispatchScope = NonNullable<Awaited<ReturnType<typeof handymanScopeAssignmentRepository.findScopeById>>>;
type Executor = Pick<PoolClient, 'query'>;
type DispatchAssignment = NonNullable<Awaited<ReturnType<typeof handymanScopeAssignmentRepository.findActiveAssignmentByScope>>>;

/** PART05 consumer of existing readiness authorities, not a new readiness engine.
 * Callers hold scope → crew/roster → visit → permit → access locks through commit.
 * Absence is UNKNOWN, not an exemption: current schemas have no trusted
 * required/not-required decision. Never infer one from notes or caller flags.
 */
async function readExecutionClearance(
  db: Executor, scope: DispatchScope, assignment: DispatchAssignment,
  appointmentId?: string | null, requireCurrentWindow = false, isRework = false,
) {
  const crew = await readBmCrewBinding(db, { clientId: scope.clientId,
    crewId: assignment.handymanCrewId, providerContextId: assignment.handymanProviderContextId });
  const visits = await db.query<{ id: string; start_at: Date; end_at: Date }>(
    `SELECT id, start_at, end_at FROM handyman_visit_appointments
      WHERE execution_scope_id = $1 AND client_id = $2
        AND handyman_request_id = $3 AND building_id = $4
        AND kind = 'EXECUTION' AND resource_type = 'CREW' AND resource_id = $5
        AND state IN ('CONFIRMED','IN_PROGRESS')
        AND ($6::uuid IS NULL OR id = $6)
        ${isRework ? 'AND hm_rework_dispatch_visit_current($1,id,$7)' : ''}
      ORDER BY created_at DESC LIMIT 1 FOR SHARE`,
    [scope.id, scope.clientId, scope.handymanRequestId, scope.buildingId, assignment.handymanCrewId, appointmentId ?? null,
      ...(isRework ? [assignment.id] : [])],
  );
  const visit = visits.rows[0];
  const location = (await db.query<{
    space_id: string; room_id: string; area_id: string; floor_id: string;
  }>(
    `SELECT r.space_id, s.room_id, rm.area_id, a.floor_id
       FROM handyman_service_requests r
       JOIN spaces s ON s.id = r.space_id
       JOIN rooms rm ON rm.id = s.room_id
       JOIN areas a ON a.id = rm.area_id
       JOIN floors f ON f.id = a.floor_id AND f.building_id = r.building_id
      WHERE r.id = $1 AND r.client_id = $2 AND r.building_id = $3
      FOR SHARE OF r, s, rm, a, f`,
    [scope.handymanRequestId, scope.clientId, scope.buildingId],
  )).rows[0];
  // Re-read UNDER the repository's existing lock: a concurrent supersession
  // either waits for this decision or leaves an INACTIVE row which fails.
  const p = await handymanPermitReadinessRepository.findActiveByRequest(db, scope.handymanRequestId);
  const permit = p ? await handymanPermitReadinessRepository.lockById(db, p.id) : null;
  const a = await handymanUnitAccessReadinessRepository.findActiveByRequest(db, scope.handymanRequestId);
  const access = a ? await handymanUnitAccessReadinessRepository.lockById(db, a.id) : null;
  // Wall clock AFTER lock waits, not PostgreSQL transaction-start NOW().
  const now = (await db.query<{ now: Date }>('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
  const scheduled = !!visit && visit.end_at.getTime() > now &&
    (!requireCurrentWindow || visit.start_at.getTime() <= now);
  const sameLocation = (row: NonNullable<typeof permit> | NonNullable<typeof access> | null) =>
    !!row && !!location && row.status === 'ACTIVE' &&
    row.clientId === scope.clientId && row.handymanRequestId === scope.handymanRequestId &&
    row.buildingId === scope.buildingId && row.spaceId === location.space_id &&
    row.roomId === location.room_id && row.areaId === location.area_id && row.floorId === location.floor_id;
  const permitClearance = scheduled && sameLocation(permit) && !!permit &&
    permit.validFrom <= visit.start_at && permit.validUntil >= visit.end_at;
  const unitAccessClearance = scheduled && sameLocation(access) && !!access &&
    access.accessWindowStart <= visit.start_at && access.accessWindowEnd >= visit.end_at;
  let bmClearance: HandymanBmClearanceAssessment = {
    state: 'LOCAL_FACTS_MISSING', bindingDigest: null, verificationReference: null,
  };
  if (scope.status === 'AUTHORIZED' && crew && location && visit && permit && access &&
      permitClearance && unitAccessClearance) {
    const work = await readBmWorkBinding(db, scope.id);
    bmClearance = await assessHandymanBmClearance(db, {
      protocol: 'HANDYMAN_BM_CLEARANCE_V1', clientId: scope.clientId,
      buildingId: scope.buildingId, executionScopeId: scope.id,
      handymanRequestId: scope.handymanRequestId, assignmentId: assignment.id,
      ...work, ...crew,
      location: { spaceId: location.space_id, roomId: location.room_id,
        areaId: location.area_id, floorId: location.floor_id },
      visit: { id: visit.id, startAt: visit.start_at.toISOString(), endAt: visit.end_at.toISOString() },
      localPermit: { id: permit.id, permitType: permit.permitType,
        validFrom: permit.validFrom.toISOString(), validUntil: permit.validUntil.toISOString() },
      localAccess: { id: access.id, startAt: access.accessWindowStart.toISOString(),
        endAt: access.accessWindowEnd.toISOString() },
    });
  }
  return {
    appointmentId: scheduled ? visit.id : null,
    startAt: visit?.start_at ?? null, endAt: visit?.end_at ?? null,
    permitClearance, unitAccessClearance, bmClearance,
    currentLeadUserId: crew?.leadUserId ?? null,
  };
}

/** Re-prove the RELEASED visit and current clearances before NEW execution.
 * Historical idempotent acknowledgments do not call this or start new work.
 */
/** Rework callers must lock request → original scope via lockReworkDispatchLineage before the child. */
export async function assertDispatchExecutionClearance(
  tx: PoolClient, executionScopeId: string, actorUserId: string, assignmentId: string,
): Promise<void> {
  const scope = await handymanScopeAssignmentRepository.lockScopeById(tx, executionScopeId);
  if (!scope) throw handymanExecutionScopeNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId, buildingId: scope.buildingId,
  }, tx);
  const assignment = await handymanScopeAssignmentRepository.findActiveAssignmentByScope(tx, scope.id);
  const release = await handymanDispatchRepository.lockActiveByScope(tx, scope.id);
  if (scope.status !== 'AUTHORIZED' || !(await hasApprovedScopeQuotation(tx, scope.id)) ||
      !assignment || assignment.id !== assignmentId ||
      !release || release.assignmentId !== assignment.id || !release.appointmentId) {
    throw handymanDispatchNotReadyError(['Current approved quotation, AUTHORIZED scope, assignment and dispatch release are required.']);
  }
  const rework = await readReworkDispatchBasis(tx, scope.id);
  const clearance = await readExecutionClearance(tx, scope, assignment, release.appointmentId, true, rework.isRework);
  const requiredPaymentSatisfied = rework.isRework ? rework.covered : await hasRequiredDispatchPayment(tx, scope);
  const failures = [];
  if (!requiredPaymentSatisfied) failures.push(rework.isRework
    ? 'Covered noncommercial warranty approval is missing or stale.'
    : 'Required quotation DP is not confirmed net of refunds and reversals.');
  if (!clearance.appointmentId) failures.push('Released execution visit is not current/confirmed for this crew and Building.');
  if (!clearance.permitClearance) failures.push('No active, scope-matching permit covers the execution visit; absence is not an exemption.');
  if (!clearance.unitAccessClearance) failures.push('No active, scope-matching unit access covers the execution visit; absence is not an exemption.');
  if (clearance.currentLeadUserId !== actorUserId) failures.push('Execution requires the current eligible Crew Lead under the roster lock.');
  if (!['NOT_INTEGRATED', 'VERIFIED'].includes(clearance.bmClearance.state)) {
    failures.push(`Optional BM verification is ${clearance.bmClearance.state}; it cannot override failed readiness.`);
  }
  if (failures.length) throw handymanDispatchNotReadyError(failures);
}

/**
 * P0-C: evaluate dispatch readiness for an execution scope. Each check is
 * resolved against the existing authorities (scope, assignment, appointment,
 * permit, unit-access, work-session). Returns the full report; callers decide
 * whether to hard-fail based on `ready`.
 */
export async function evaluateDispatchReadiness(
  executionScopeId: string,
  actorUserId: string,
  executor?: PoolClient,
): Promise<HandymanDispatchReadinessReport> {
  const scopeId = ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');
  if (!executor) return withTransaction((tx) => evaluateDispatchReadiness(scopeId, actorUserId, tx));
  const db = executor;
  await lockReworkDispatchLineage(db, scopeId);

  const scope = await handymanScopeAssignmentRepository.lockScopeById(
    db,
    scopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  }, executor);

  // Rework is explicitly noncommercial and must retain the independently verified COVERED claim.
  const rework = await readReworkDispatchBasis(db,scope.id);
  const authorizedScope = scope.status === 'AUTHORIZED' && (!rework.isRework || rework.covered)
    && await hasApprovedScopeQuotation(db, scope.id);

  // 2. Active assignment
  const assignment =
    await handymanScopeAssignmentRepository.findActiveAssignmentByScope(
      db,
      scopeId,
    );
  const assignmentCurrent = assignment !== null;

  // 3. Existing confirmed visit + authoritative scoped/windowed readiness.
  const clearance = assignment
    ? await readExecutionClearance(db, scope, assignment, null, false, rework.isRework)
    : null;
  const appointmentId = clearance?.appointmentId ?? null;
  const confirmedAppointment = appointmentId !== null;

  // 4. Eligible provider/crew/lead (re-use existing eligibility; checked via
  //    assignment insertion; verify snapshot still ACTIVE).
  let eligibleProvider = false;
  let eligibleCrew = false;
  let eligibleLead = false;
  let leadDeclinedAssignment = false;
  if (assignment) {
    const rows = await db.query(
      `SELECT pc.status AS pc_status, c.status AS c_status,
              (SELECT wp.user_id FROM handyman_crew_leads cl
                 JOIN handyman_crew_memberships cm ON cm.id=cl.handyman_crew_membership_id
                   AND cm.status='ACTIVE'
                 JOIN handyman_worker_contexts wc ON wc.id=cm.handyman_worker_context_id
                   AND wc.status='ACTIVE'
                 JOIN workforce_profiles wp ON wp.id=wc.workforce_profile_id
                   AND wp.status='ACTIVE' AND wp.user_id IS NOT NULL
                 JOIN users u ON u.id=wp.user_id AND u.status='ACTIVE'
                WHERE cl.handyman_crew_id=c.id
                ORDER BY cl.lead_seq DESC LIMIT 1) AS lead_user_id,
              (SELECT ar.response_status
                 FROM handyman_assignment_responses ar
                WHERE ar.assignment_id = $4
                  AND ar.assignment_target_type = 'EXECUTION_SCOPE_ASSIGNMENT'
                LIMIT 1) AS response_status
         FROM handyman_provider_contexts pc
         JOIN handyman_work_crews c ON c.id=$3 AND c.handyman_provider_context_id=pc.id
           AND c.client_id=pc.client_id
        WHERE pc.id=$2 AND pc.client_id=$1`,
      [
        scope.clientId,
        assignment.handymanProviderContextId,
        assignment.handymanCrewId,
        assignment.id,
      ],
    );
    const row = rows.rows[0];
    if (row) {
      eligibleProvider = row.pc_status === 'ACTIVE';
      eligibleCrew = row.c_status === 'ACTIVE';
      leadDeclinedAssignment = row.response_status === 'TIDAK_BISA';
      eligibleLead = !!row.lead_user_id && !leadDeclinedAssignment &&
        clearance?.currentLeadUserId === row.lead_user_id;
    }
  }

  // 5. No conflicting crew commitment — another ACTIVE work session, OR an
  //    overlapping CONFIRMED/IN_PROGRESS EXECUTION appointment already
  //    reserved for this crew (double-book). Dispatch release must not
  //    silently allocate the same crew to two overlapping windows, even
  //    before either session starts.
  let noConflictingCommitment = true;
  const confirmedStartAt = clearance?.startAt ?? null;
  const confirmedEndAt = clearance?.endAt ?? null;
  if (assignment) {
    const conflicts = await db.query(
      `SELECT 1 FROM handyman_execution_scope_assignments a
         JOIN handyman_work_sessions ws ON ws.execution_scope_id=a.execution_scope_id
           AND ws.status <> 'CHECKED_OUT'
        WHERE a.handyman_crew_id = $1 AND a.client_id = $2 AND a.status='ACTIVE'
          AND a.execution_scope_id <> $3
        LIMIT 1`,
      [assignment.handymanCrewId, scope.clientId, scopeId],
    );
    if (conflicts.rows.length > 0) noConflictingCommitment = false;

    if (noConflictingCommitment && confirmedStartAt && confirmedEndAt) {
      const overlap = await db.query(
        `SELECT 1 FROM handyman_visit_capacity_reservations r
           JOIN handyman_visit_appointments v ON v.id = r.appointment_id
             AND v.client_id = r.client_id
             AND v.kind = 'EXECUTION'
             AND v.state IN ('CONFIRMED','IN_PROGRESS')
          WHERE r.active = TRUE
            AND r.client_id = $1
            AND r.resource_type = 'CREW'
            AND r.resource_id = $2
            AND tstzrange(r.start_at, r.end_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
            AND v.id <> $5
          LIMIT 1`,
        [
          scope.clientId,
          assignment.handymanCrewId,
          confirmedStartAt,
          confirmedEndAt,
          appointmentId,
        ],
      );
      if (overlap.rows.length > 0) noConflictingCommitment = false;
    }
  }

  // 6/7. Missing/inactive/foreign/out-of-window facts fail closed. There is
  // no authoritative exemption field in the existing readiness contract.
  const permitClearance = clearance?.permitClearance ?? false;
  const unitAccessClearance = clearance?.unitAccessClearance ?? false;

  // 8. Material readiness — any non-terminal material record blocks release.
  //    Status phases: APPROVAL, ISSUED, PURCHASED, USAGE, RETURN, RECONCILIATION.
  //    Terminal for dispatch purposes = USAGE-or-later indicates material
  //    already picked up; APPROVAL/ISSUED indicate procurement still pending.
  const materialRes = await db.query(
    `SELECT 1 FROM handyman_material_purchase_records
        WHERE execution_scope_id = $1 AND client_id = $2
          AND status IN ('APPROVAL','ISSUED')
        LIMIT 1`,
    [scopeId, scope.clientId],
  );
  const materialReady = materialRes.rows.length === 0;
  const requiredPaymentSatisfied = authorizedScope && (rework.isRework ? rework.covered : await hasRequiredDispatchPayment(db, scope));

  const checks: HandymanDispatchReadinessCheck = {
    authorizedScope,
    confirmedAppointment,
    eligibleProvider,
    eligibleCrew,
    eligibleLead,
    noConflictingCommitment,
    permitClearance,
    unitAccessClearance,
    materialReady,
    requiredPaymentSatisfied,
    assignmentCurrent,
  };
  const failures: string[] = [];
  if (!authorizedScope) failures.push('Execution scope has no matching approved quotation decision.');
  if (!requiredPaymentSatisfied) failures.push(rework.isRework
    ? 'Covered noncommercial warranty approval is missing or stale.'
    : 'Required quotation DP is not confirmed net of refunds and reversals.');
  if (!assignmentCurrent) failures.push('No ACTIVE crew assignment.');
  if (!confirmedAppointment) failures.push('No CONFIRMED execution appointment.');
  if (!eligibleProvider) failures.push('Provider context is not ACTIVE.');
  if (!eligibleCrew) failures.push('Crew is not ACTIVE.');
  if (leadDeclinedAssignment) {
    failures.push('Crew Lead declined assignment (TIDAK_BISA); reassignment required.');
  } else if (!eligibleLead) {
    failures.push('Current Crew Lead or active worker roster is not eligible.');
  }
  if (!noConflictingCommitment) failures.push('Crew has another active work session.');
  if (!permitClearance) failures.push('No active matching permit covers the visit; missing readiness is not a trusted exemption.');
  if (!unitAccessClearance) failures.push('No active matching unit access covers the visit; missing readiness is not a trusted exemption.');
  if (!materialReady) failures.push('Materials are not ready (open purchase).');
  if (clearance && !['NOT_INTEGRATED', 'VERIFIED'].includes(clearance.bmClearance.state)) {
    failures.push(`Optional BM verification is ${clearance.bmClearance.state}; no BM API is required for existing manual coordination.`);
  }

  return {
    executionScopeId: scopeId,
    ready: failures.length === 0,
    checks,
    failures,
    appointmentId,
    assignmentId: assignment?.id ?? null,
    assignmentReadiness: failures.length === 0 ? 'DISPATCH_READY' : assignment ? 'PLANNED' : 'UNASSIGNED',
    bmClearance: clearance?.bmClearance ?? {
      state: 'LOCAL_FACTS_MISSING', bindingDigest: null, verificationReference: null,
    },
    ...(rework.isRework && rework.covered ? {paymentRequirement: 'COVERED_NONCOMMERCIAL_REWORK' as const} : {}),
  };
}

export async function releaseHandymanDispatch(
  input: ReleaseHandymanDispatchInput,
  actorUserId: string,
): Promise<PublicHandymanDispatchRelease> {
  const scopeId = ensureUuid(input.executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');

  return withTransaction(async (tx) => {
    await lockReworkDispatchLineage(tx,scopeId);
    const scope = await handymanScopeAssignmentRepository.lockScopeById(
      tx,
      scopeId,
    );
    if (!scope) throw handymanExecutionScopeNotFoundError();
    const rework=await readReworkDispatchBasis(tx,scopeId);
    if (rework.isRework) await assertWarrantyReworkOperations(tx,scope,actorUserId);
    // Evaluate readiness inside the transaction against the locked scope.
    // The lockScopeById uses SELECT ... FOR UPDATE which serializes
    // concurrent release attempts on the same scope; below we also rely on
    // the partial unique index on ACTIVE releases as defense-in-depth.
    const readiness = await evaluateDispatchReadiness(scopeId, actorUserId, tx);
    if (!readiness.ready) {
      throw handymanDispatchNotReadyError(readiness.failures);
    }
    const active = await handymanDispatchRepository.lockActiveByScope(
      tx,
      scopeId,
    );
    if (active) {
      throw handymanDispatchReleaseConflictError(
        'An ACTIVE dispatch release already exists for this scope.',
      );
    }
    if (input.appointmentId != null &&
        ensureUuid(input.appointmentId, 'appointmentId').toLowerCase() !== readiness.appointmentId) {
      throw handymanDispatchNotReadyError(['appointmentId must match the current crew visit evaluated by Backend.']);
    }
    const appointmentId = readiness.appointmentId;
    if (!appointmentId) {
      throw handymanDispatchNotReadyError([
        'A CONFIRMED execution appointment is required for release.',
      ]);
    }
    const record = await handymanDispatchRepository.insert(tx, {
      clientId: scope.clientId,
      executionScopeId: scopeId,
      assignmentId: readiness.assignmentId!,
      appointmentId,
      releasedByUserId: actorUserId,
      readinessSnapshot: { ...readiness.checks, bmClearance: readiness.bmClearance,
        ...(readiness.paymentRequirement ? {paymentRequirement:readiness.paymentRequirement} : {}) },
    });
    await recordOperationalEvent(
      {
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        eventType: 'HANDYMAN_DISPATCH_RELEASED',
        entityType: 'HANDYMAN_DISPATCH_RELEASE',
        entityId: record.id,
        actorUserId,
        summary: 'Handyman execution scope released for dispatch.',
        metadata: {
          executionScopeId: scopeId,
          assignmentId: record.assignmentId,
          appointmentId: record.appointmentId,
          checks: readiness.checks,
        },
      },
      tx,
    );
    return toPublic(record);
  });
}

export async function getActiveDispatchRelease(
  executionScopeId: string,
  actorUserId: string,
): Promise<PublicHandymanDispatchRelease | null> {
  const scopeId = ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    scopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });
  const release = await handymanDispatchRepository.findActiveByScope(
    undefined,
    scopeId,
  );
  return release ? toPublic(release) : null;
}

/** Advance RELEASED → IN_PROGRESS (called when PIC checks in). */
export async function markDispatchInProgress(
  executionScopeId: string,
  actorUserId: string,
  tx?: PoolClient,
): Promise<void> {
  const scopeId = ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');
  const run = async (executor: PoolClient) => {
    const active = await handymanDispatchRepository.lockActiveByScope(
      executor,
      scopeId,
    );
    if (!active || active.status !== 'RELEASED') return;
    await handymanDispatchRepository.markInProgress(executor, active.id);
  };
  if (tx) {
    await run(tx);
  } else {
    await withTransaction(run);
  }
}

/** Advance IN_PROGRESS → COMPLETED (called at CHECK_OUT). */
export async function markDispatchCompleted(
  executionScopeId: string,
  actorUserId: string,
  tx?: PoolClient,
): Promise<void> {
  const scopeId = ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');
  const run = async (executor: PoolClient) => {
    const active = await handymanDispatchRepository.lockActiveByScope(
      executor,
      scopeId,
    );
    if (!active || active.status !== 'IN_PROGRESS') return;
    await handymanDispatchRepository.markCompleted(executor, active.id);
  };
  if (tx) await run(tx);
  else await withTransaction(run);
}

export async function cancelDispatchRelease(
  executionScopeId: string,
  reason: string,
  actorUserId: string,
): Promise<PublicHandymanDispatchRelease> {
  const scopeId = ensureUuid(executionScopeId, 'executionScopeId');
  ensureUuid(actorUserId, 'actorUserId');
  const reasonText = typeof reason === 'string' ? reason.trim() : '';
  if (reasonText.length < 1 || reasonText.length > 1000) {
    throw new Error('HANDYMAN_DISPATCH_INVALID_REASON');
  }
  return withTransaction(async (tx) => {
    const scope = await handymanScopeAssignmentRepository.lockScopeById(
      tx,
      scopeId,
    );
    if (!scope) throw handymanExecutionScopeNotFoundError();
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
    });
    const active = await handymanDispatchRepository.lockActiveByScope(
      tx,
      scopeId,
    );
    if (!active) throw handymanDispatchReleaseNotFoundError();
    const cancelled = await handymanDispatchRepository.cancel(
      tx,
      active.id,
      actorUserId,
      reasonText,
    );
    if (!cancelled) throw handymanDispatchReleaseConflictError('Invalid state.');
    await recordOperationalEvent(
      {
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        eventType: 'HANDYMAN_DISPATCH_CANCELLED',
        entityType: 'HANDYMAN_DISPATCH_RELEASE',
        entityId: cancelled.id,
        actorUserId,
        summary: `Dispatch release cancelled: ${reasonText}`,
        metadata: {
          executionScopeId: scopeId,
          reason: reasonText,
        },
      },
      tx,
    );
    return toPublic(cancelled);
  });
}

export const handymanDispatchService = {
  evaluateDispatchReadiness,
  assertDispatchExecutionClearance,
  releaseHandymanDispatch,
  getActiveDispatchRelease,
  markDispatchInProgress,
  markDispatchCompleted,
  cancelDispatchRelease,
};

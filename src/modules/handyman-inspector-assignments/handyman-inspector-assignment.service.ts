import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { canAccessBuildingScopedResource } from '../context-access';
import { findEligibleHandymanWorker } from '../handyman-providers/handyman-worker-eligibility.repository';
import { recordOperationalEvent } from '../operational-events';
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
  notifyInspectorAssignedPending,
  notifyInspectorAssignmentAccepted,
  notifyInspectorAssignmentDeclined,
  notifyInspectorAssignmentSuperseded,
  toPublicAssignmentResponseEvent,
  type HandymanAssignmentResponseRecord,
} from '../assignment-responses';
import { AppError } from '../../shared/errors';
import {
  handymanInspectorAssignmentConflictError,
  handymanInspectorAssignmentIneligibleError,
  handymanInspectorAssignmentNotFoundError,
  handymanInspectorCapacityConflictError,
  handymanInspectorVersionConflictError,
  handymanInspectorVisitInvalidError,
} from './handyman-inspector-assignment.errors';
import { handymanInspectorAssignmentRepository } from './handyman-inspector-assignment.repository';
import type {
  AssignHandymanInspectorInput,
  EligibleInspectorProjection,
  HandymanInspectorAssignmentRecord,
  HandymanInspectorAssignmentResponseHistoryView,
  HandymanInspectorAssignmentResponseView,
  PublicHandymanInspectorAssignment,
  ReassignHandymanInspectorInput,
  RespondToHandymanInspectorAssignmentInput,
} from './handyman-inspector-assignment.types';

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw new Error(`HANDYMAN_INSPECTOR_ASSIGNMENT_INVALID_UUID:${field}`);
  }
  return raw;
}

function ensureReason(value: string | undefined): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length < 1 || raw.length > 1000) {
    throw new Error('HANDYMAN_INSPECTOR_ASSIGNMENT_INVALID_REASON');
  }
  return raw;
}

function toPublic(
  record: HandymanInspectorAssignmentRecord,
  response?: HandymanAssignmentResponseRecord | null,
): PublicHandymanInspectorAssignment {
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
    acknowledgedAt:
      responseStatus === 'TERIMA' && response?.respondedAt
        ? response.respondedAt.toISOString()
        : null,
  };
}

/**
 * Enforce eligibility: user ACTIVE, building+client access, registered as
 * eligible handyman worker with ACTIVE login placement at the building.
 */
async function assertInspectorEligible(
  tx: PoolClient,
  params: { clientId: string; buildingId: string; userId: string },
): Promise<void> {
  const active = await tx.query(
    `SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE'`,
    [params.userId],
  );
  if (active.rows.length === 0) {
    throw handymanInspectorAssignmentIneligibleError('User is not active.');
  }
  const hasBuildingAccess = await canAccessBuildingScopedResource(
    params.userId,
    { clientId: params.clientId, buildingId: params.buildingId },
  );
  if (!hasBuildingAccess) {
    throw handymanInspectorAssignmentIneligibleError(
      'Inspector is not assigned to this building.',
    );
  }
  const eligible = await findEligibleHandymanWorker(tx, {
    clientId: params.clientId,
    buildingId: params.buildingId,
    userId: params.userId,
    requireLogin: true,
  });
  if (!eligible) {
    throw handymanInspectorAssignmentIneligibleError(
      'Inspector lacks active Handyman worker registration at this building.',
    );
  }
}

/**
 * Capacity: Inspector must not have an overlapping ACTIVE visit capacity
 * reservation for any other appointment.
 */
async function assertNoOverlappingCapacity(
  tx: PoolClient,
  params: {
    clientId: string;
    inspectorUserId: string;
    startAt: Date;
    endAt: Date;
    excludeVisitId?: string;
  },
): Promise<void> {
  const result = await tx.query(
    `SELECT 1 FROM handyman_visit_capacity_reservations r
       JOIN handyman_visit_appointments a ON a.id = r.appointment_id
      WHERE r.active = TRUE AND r.client_id = $1
        AND r.resource_type = 'INSPECTOR_USER'
        AND r.resource_id = $2
        AND tstzrange(r.start_at, r.end_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
        AND ($5::uuid IS NULL OR a.id <> $5)
      LIMIT 1`,
    [
      params.clientId,
      params.inspectorUserId,
      params.startAt,
      params.endAt,
      params.excludeVisitId ?? null,
    ],
  );
  if (result.rows.length > 0) {
    throw handymanInspectorCapacityConflictError();
  }
}

async function journal(
  tx: PoolClient,
  record: HandymanInspectorAssignmentRecord,
  eventType: string,
  summary: string,
): Promise<void> {
  const visit = await handymanInspectorAssignmentRepository.findVisit(
    tx,
    record.visitAppointmentId,
  );
  await recordOperationalEvent(
    {
      clientId: record.clientId,
      eventType,
      entityType: 'HANDYMAN_INSPECTOR_ASSIGNMENT',
      entityId: record.id,
      actorUserId: record.assignedByUserId,
      buildingId: visit?.buildingId,
      summary,
      metadata: {
        assignmentId: record.id,
        visitAppointmentId: record.visitAppointmentId,
        handymanRequestId: record.handymanRequestId,
        inspectorUserId: record.inspectorUserId,
        status: record.status,
        supersedesAssignmentId: record.supersedesAssignmentId,
        reason: record.reassignmentReason,
      },
    },
    tx,
  );
}

/**
 * List eligible inspectors for a given visit appointment.
 */
export async function listEligibleInspectorsForVisit(
  visitAppointmentId: string,
  actorUserId: string,
): Promise<EligibleInspectorProjection[]> {
  const visitId = ensureUuid(visitAppointmentId, 'visitAppointmentId');
  ensureUuid(actorUserId, 'actorUserId');

  const visit = await handymanInspectorAssignmentRepository.findVisit(
    undefined,
    visitId,
  );
  if (!visit) throw handymanInspectorAssignmentNotFoundError();
  if (visit.kind !== 'INSPECTION') {
    throw handymanInspectorVisitInvalidError('Visit kind must be INSPECTION.');
  }
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: visit.clientId,
    buildingId: visit.buildingId,
  });

  const db = getPool();
  const rows = await db.query<{
    userId: string;
    workforceProfileId: string;
    workerContextId: string | null;
    fullName: string | null;
  }>(
    `SELECT u.id AS "userId",
            fp.id AS "workforceProfileId",
            wc.id AS "workerContextId",
            u.display_name AS "fullName"
       FROM users u
       JOIN user_building_assignments uba
         ON uba.user_id = u.id
        AND uba.building_id = $2
        AND uba.status = 'ACTIVE'
       -- CR-HM-WORKER-COMPETENCY-01 PART 03B2D: no workforce_type filter. The
       -- inspector pool is Handyman's own personnel (permanent, contract or
       -- freelance) and must not be limited to vendor-typed (EXTERNAL)
       -- profiles. Real admission is decided below by the single
       -- findEligibleHandymanWorker authority (ACTIVE context, provider kind,
       -- vendor binding only for VENDOR providers, Building placement).
       JOIN workforce_profiles fp ON fp.user_id = u.id AND fp.status = 'ACTIVE'
       LEFT JOIN handyman_worker_contexts wc
         ON wc.workforce_profile_id = fp.id
        AND wc.client_id = $1 AND wc.status = 'ACTIVE'
      WHERE u.status = 'ACTIVE'
      ORDER BY u.display_name ASC NULLS LAST, u.id ASC`,
    [visit.clientId, visit.buildingId],
  );

  const results: EligibleInspectorProjection[] = [];
  for (const row of rows.rows) {
    const eligible = await findEligibleHandymanWorker(db, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      userId: row.userId,
      requireLogin: true,
    });
    if (!eligible) continue;

    const conflict = await db.query(
      `SELECT 1 FROM handyman_visit_capacity_reservations r
         JOIN handyman_visit_appointments a ON a.id = r.appointment_id
        WHERE r.active = TRUE AND r.client_id = $1
          AND r.resource_type = 'INSPECTOR_USER'
          AND r.resource_id = $2
          AND tstzrange(r.start_at, r.end_at, '[)') && tstzrange($3::timestamptz, $4::timestamptz, '[)')
          AND a.id <> $5
        LIMIT 1`,
      [
        visit.clientId,
        row.userId,
        visit.startAt,
        visit.endAt,
        visit.id,
      ],
    );
    results.push({
      userId: row.userId,
      workforceProfileId: row.workforceProfileId,
      workerContextId: row.workerContextId,
      fullName: row.fullName,
      hasConflict: conflict.rows.length > 0,
    });
  }
  return results;
}

/** Initial assignment: no active row exists yet. */
export async function assignInspectorToVisit(
  input: AssignHandymanInspectorInput,
  actorUserId: string,
): Promise<PublicHandymanInspectorAssignment> {
  const visitId = ensureUuid(input.visitAppointmentId, 'visitAppointmentId');
  const inspectorId = ensureUuid(input.inspectorUserId, 'inspectorUserId');
  ensureUuid(actorUserId, 'actorUserId');

  return withTransaction(async (tx) => {
    const visit = await handymanInspectorAssignmentRepository.lockVisit(
      tx,
      visitId,
    );
    if (!visit) {
      throw handymanInspectorAssignmentNotFoundError();
    }
    if (visit.kind !== 'INSPECTION') {
      throw handymanInspectorVisitInvalidError(
        'Visit kind must be INSPECTION.',
      );
    }
    if (visit.state === 'CANCELLED') {
      throw handymanInspectorVisitInvalidError(
        'Visit is CANCELLED and cannot be assigned.',
      );
    }
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
    });
    const existing =
      await handymanInspectorAssignmentRepository.lockActiveByVisit(
        tx,
        visitId,
      );
    if (existing) throw handymanInspectorAssignmentConflictError();

    await assertInspectorEligible(tx, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      userId: inspectorId,
    });
    // Only enforce capacity conflict for CONFIRMED/IN_PROGRESS visits (where a
    // reservation must exist). PROPOSED/TENANT_SELECTED may double-book but
    // confirmation will fail if the reservation is already taken.
    if (visit.state === 'CONFIRMED' || visit.state === 'IN_PROGRESS') {
      await assertNoOverlappingCapacity(tx, {
        clientId: visit.clientId,
        inspectorUserId: inspectorId,
        startAt: visit.startAt,
        endAt: visit.endAt,
        excludeVisitId: visit.id,
      });
    }

    const record = await handymanInspectorAssignmentRepository.insert(tx, {
      clientId: visit.clientId,
      handymanRequestId: visit.handymanRequestId,
      visitAppointmentId: visit.id,
      inspectorUserId: inspectorId,
      status: 'ACTIVE',
      assignedByUserId: actorUserId,
      supersedesAssignmentId: null,
    });
    await journal(
      tx,
      record,
      'HANDYMAN_INSPECTOR_ASSIGNMENT_CREATED',
      `Inspector assigned to inspection visit ${visit.id}.`,
    );
    const pendingResponse =
      await assignmentResponseRepository.ensurePendingForAssignment(
        {
          assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
          assignmentId: record.id,
          clientId: visit.clientId,
          buildingId: visit.buildingId,
          handymanRequestId: visit.handymanRequestId,
          visitAppointmentId: visit.id,
          assignedByUserId: actorUserId,
          assignedAt: record.assignedAt,
        },
        tx,
      );
    await notifyInspectorAssignedPending(
      {
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
        assignmentId: record.id,
        inspectorUserId: record.inspectorUserId,
      },
      tx,
    );
    return toPublic(record, pendingResponse);
  });
}

/** Reassign (or revoke) with expected-version guard and required reason. */
export async function reassignInspectorForVisit(
  input: ReassignHandymanInspectorInput,
  actorUserId: string,
): Promise<PublicHandymanInspectorAssignment> {
  const visitId = ensureUuid(input.visitAppointmentId, 'visitAppointmentId');
  const inspectorId = ensureUuid(input.inspectorUserId, 'inspectorUserId');
  ensureUuid(actorUserId, 'actorUserId');
  const reason = ensureReason(input.reason);

  return withTransaction(async (tx) => {
    const visit = await handymanInspectorAssignmentRepository.lockVisit(
      tx,
      visitId,
    );
    if (!visit) {
      throw handymanInspectorAssignmentNotFoundError();
    }
    if (visit.kind !== 'INSPECTION') {
      throw handymanInspectorVisitInvalidError(
        'Visit kind must be INSPECTION.',
      );
    }
    if (visit.state === 'IN_PROGRESS') {
      throw handymanInspectorVisitInvalidError(
        'Cannot reassign: inspection visit is already IN_PROGRESS.',
      );
    }
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
    });

    const current =
      await handymanInspectorAssignmentRepository.lockActiveByVisit(
        tx,
        visitId,
      );
    if (!current) throw handymanInspectorAssignmentNotFoundError();
    if (current.version !== input.expectedVersion) {
      throw handymanInspectorVersionConflictError();
    }

    // Idempotency guard: same inspector => already current assignment (treat as no-op replay).
    if (current.inspectorUserId === inspectorId) {
      const currentResponse =
        await assignmentResponseRepository.findByAssignmentId(
          current.id,
          tx,
        );
      return toPublic(current, currentResponse);
    }

    await assertInspectorEligible(tx, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      userId: inspectorId,
    });
    if (visit.state === 'CONFIRMED' || visit.state === 'IN_PROGRESS') {
      await assertNoOverlappingCapacity(tx, {
        clientId: visit.clientId,
        inspectorUserId: inspectorId,
        startAt: visit.startAt,
        endAt: visit.endAt,
        excludeVisitId: visit.id,
      });
    }

    const superseded = await handymanInspectorAssignmentRepository.supersede(
      tx,
      current.id,
      'SUPERSEDED',
      reason,
      input.expectedVersion,
    );
    if (!superseded) throw handymanInspectorVersionConflictError();
    await journal(
      tx,
      superseded,
      'HANDYMAN_INSPECTOR_ASSIGNMENT_SUPERSEDED',
      `Inspector assignment reassigned: ${reason}`,
    );

    const record = await handymanInspectorAssignmentRepository.insert(tx, {
      clientId: visit.clientId,
      handymanRequestId: visit.handymanRequestId,
      visitAppointmentId: visit.id,
      inspectorUserId: inspectorId,
      status: 'ACTIVE',
      assignedByUserId: actorUserId,
      supersedesAssignmentId: current.id,
      reassignmentReason: reason,
    });
    await journal(
      tx,
      record,
      'HANDYMAN_INSPECTOR_ASSIGNMENT_CREATED',
      `Inspector reassigned to visit ${visit.id} (new assignment).`,
    );

    await assignmentResponseRepository.recordSupersededEvent(
      {
        assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
        assignmentId: current.id,
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
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
          assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
          assignmentId: record.id,
          clientId: visit.clientId,
          buildingId: visit.buildingId,
          handymanRequestId: visit.handymanRequestId,
          visitAppointmentId: visit.id,
          assignedByUserId: actorUserId,
          assignedAt: record.assignedAt,
        },
        tx,
      );
    await notifyInspectorAssignmentSuperseded(
      {
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
        oldAssignmentId: current.id,
        newAssignmentId: record.id,
        oldInspectorUserId: current.inspectorUserId,
        newInspectorUserId: record.inspectorUserId,
        reason,
        action: 'SUPERSEDED',
      },
      tx,
    );
    await notifyInspectorAssignedPending(
      {
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
        assignmentId: record.id,
        inspectorUserId: record.inspectorUserId,
      },
      tx,
    );
    return toPublic(record, pendingResponse);
  });
}

export async function revokeInspectorAssignment(
  visitAppointmentId: string,
  expectedVersion: number,
  reason: string,
  actorUserId: string,
): Promise<PublicHandymanInspectorAssignment> {
  const visitId = ensureUuid(visitAppointmentId, 'visitAppointmentId');
  ensureUuid(actorUserId, 'actorUserId');
  const reasonText = ensureReason(reason);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new Error('HANDYMAN_INSPECTOR_ASSIGNMENT_INVALID_VERSION');
  }
  return withTransaction(async (tx) => {
    const visit = await handymanInspectorAssignmentRepository.lockVisit(
      tx,
      visitId,
    );
    if (!visit) throw handymanInspectorAssignmentNotFoundError();
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
    });
    if (visit.state === 'IN_PROGRESS') {
      throw handymanInspectorVisitInvalidError(
        'Cannot revoke: inspection visit is IN_PROGRESS.',
      );
    }
    const current =
      await handymanInspectorAssignmentRepository.lockActiveByVisit(
        tx,
        visitId,
      );
    if (!current) throw handymanInspectorAssignmentNotFoundError();
    if (current.version !== expectedVersion) {
      throw handymanInspectorVersionConflictError();
    }
    const revoked = await handymanInspectorAssignmentRepository.supersede(
      tx,
      current.id,
      'REVOKED',
      reasonText,
      expectedVersion,
    );
    if (!revoked) throw handymanInspectorVersionConflictError();
    await journal(
      tx,
      revoked,
      'HANDYMAN_INSPECTOR_ASSIGNMENT_REVOKED',
      `Inspector assignment revoked: ${reasonText}`,
    );
    await assignmentResponseRepository.recordSupersededEvent(
      {
        assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
        assignmentId: current.id,
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
        assignedByUserId: current.assignedByUserId,
        assignedAt: current.assignedAt,
      },
      actorUserId,
      reasonText,
      tx,
    );
    await notifyInspectorAssignmentSuperseded(
      {
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
        oldAssignmentId: current.id,
        newAssignmentId: null,
        oldInspectorUserId: current.inspectorUserId,
        newInspectorUserId: null,
        reason: reasonText,
        action: 'REVOKED',
      },
      tx,
    );
    const response = await assignmentResponseRepository.findByAssignmentId(
      revoked.id,
      tx,
    );
    return toPublic(revoked, response);
  });
}

export async function getInspectorAssignmentForVisit(
  visitAppointmentId: string,
  actorUserId: string,
): Promise<PublicHandymanInspectorAssignment | null> {
  const visitId = ensureUuid(visitAppointmentId, 'visitAppointmentId');
  ensureUuid(actorUserId, 'actorUserId');
  const visit = await handymanInspectorAssignmentRepository.findVisit(
    undefined,
    visitId,
  );
  if (!visit) throw handymanInspectorAssignmentNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: visit.clientId,
    buildingId: visit.buildingId,
  });
  const current = await handymanInspectorAssignmentRepository.findActiveByVisit(
    undefined,
    visitId,
  );
  if (!current) return null;
  const response = await assignmentResponseRepository.findByAssignmentId(
    current.id,
  );
  return toPublic(current, response);
}

export async function listInspectorAssignmentHistory(
  handymanRequestId: string,
  actorUserId: string,
) {
  const requestId = ensureUuid(handymanRequestId, 'handymanRequestId');
  ensureUuid(actorUserId, 'actorUserId');
  const db = getPool();
  const scope = await db.query<{ client_id: string; building_id: string }>(
    `SELECT client_id, building_id FROM handyman_service_requests WHERE id = $1`,
    [requestId],
  );
  if (!scope.rows[0]) throw handymanInspectorAssignmentNotFoundError();
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.rows[0].client_id,
    buildingId: scope.rows[0].building_id,
  });
  const rows =
    await handymanInspectorAssignmentRepository.listHistoryByRequest(
      undefined,
      scope.rows[0].client_id,
      requestId,
    );
  const results: PublicHandymanInspectorAssignment[] = [];
  for (const row of rows) {
    const response = await assignmentResponseRepository.findByAssignmentId(
      row.id,
    );
    results.push(toPublic(row, response));
  }
  return results;
}

/**
 * Helper for field read authority: determine if a user is currently the ACTIVE
 * assigned inspector for a request's latest INSPECTION visit (and has NOT
 * declined via `TIDAK_BISA`).
 */
export async function isActiveInspectorForRequest(
  clientId: string,
  requestId: string,
  userId: string,
): Promise<boolean> {
  const db = getPool();
  const visit = await db.query<{ id: string }>(
    `SELECT id FROM handyman_visit_appointments
      WHERE handyman_request_id = $1 AND client_id = $2
        AND kind = 'INSPECTION'
        AND state IN ('PROPOSED', 'TENANT_SELECTED', 'CONFIRMED', 'IN_PROGRESS')
      ORDER BY created_at DESC LIMIT 1`,
    [requestId, clientId],
  );
  if (visit.rows.length === 0) return false;
  const assignment =
    await handymanInspectorAssignmentRepository.findActiveByVisit(
      db,
      visit.rows[0].id,
    );
  if (!assignment || assignment.inspectorUserId !== userId) return false;
  const response = await assignmentResponseRepository.findByAssignmentId(
    assignment.id,
    db,
  );
  if (response?.responseStatus === 'TIDAK_BISA') return false;
  return true;
}

/**
 * CR-HM-ASSIGNMENT-RESPONSE-01 PART 02B:
 * Allows the assigned Inspector to respond `TERIMA` or `TIDAK_BISA` to an
 * Inspection Visit assignment.
 *
 * - `TIDAK_BISA` requires a non-empty `declineReason` (1..1000 chars), sets
 *   `reassignmentRequired = true`, and notifies Operations (`IN_APP`) without
 *   deleting or cancelling the Visit Appointment or Handyman Service Request.
 * - Duplicate identical responses are idempotent (`idempotentReplay: true`).
 * - Conflicting responses are rejected with `409 HANDYMAN_ASSIGNMENT_RESPONSE_CONFLICT`.
 * - Superseded or revoked assignments are rejected with `409 HANDYMAN_ASSIGNMENT_RESPONSE_SUPERSEDED`.
 * - Late responses after visit completion/cancellation or recorded inspection
 *   are rejected with `409 HANDYMAN_ASSIGNMENT_RESPONSE_LATE`.
 */
export async function respondToInspectorVisitAssignment(
  input: RespondToHandymanInspectorAssignmentInput,
  actorUserId: string,
): Promise<HandymanInspectorAssignmentResponseView> {
  const visitId = ensureUuid(input.visitAppointmentId, 'visitAppointmentId');
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
    const visit = await handymanInspectorAssignmentRepository.lockVisit(
      tx,
      visitId,
    );
    if (!visit) throw handymanInspectorAssignmentNotFoundError();

    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
    });

    const assignment =
      await handymanInspectorAssignmentRepository.lockByIdAndVisit(
        tx,
        assignmentId,
        visitId,
      );
    if (!assignment) throw handymanInspectorAssignmentNotFoundError();

    if (assignment.inspectorUserId !== actorUserId) {
      throw handymanAssignmentResponseForbiddenError(
        'Only the assigned Inspector can respond to this visit assignment.',
      );
    }

    if (assignment.status !== 'ACTIVE') {
      throw handymanAssignmentResponseSupersededError();
    }

    await assignmentResponseRepository.ensurePendingForAssignment(
      {
        assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
        assignmentId: assignment.id,
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
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
    if (!existing) throw handymanInspectorAssignmentNotFoundError();

    if (existing.responseStatus === input.responseStatus) {
      const sameDecline =
        (existing.declineReason ?? null) === normalizedDeclineReason;
      const sameNotes = (existing.responseNotes ?? null) === normalizedNotes;
      if (sameDecline && sameNotes) {
        return {
          ...toPublic(assignment, existing),
          idempotentReplay: true,
        };
      }
      throw handymanAssignmentResponseConflictError();
    }

    if (existing.responseStatus !== 'PENDING') {
      throw handymanAssignmentResponseConflictError();
    }

    // Late response guard: visit already terminal or inspection already recorded
    if (
      visit.state === 'COMPLETED' ||
      visit.state === 'CANCELLED' ||
      visit.state === 'NO_SHOW'
    ) {
      throw handymanAssignmentResponseLateError();
    }
    const inspectionRes = await tx.query(
      `SELECT 1
         FROM handyman_request_inspections
        WHERE handyman_request_id = $1
        LIMIT 1`,
      [visit.handymanRequestId],
    );
    if ((inspectionRes.rowCount ?? 0) > 0) {
      throw handymanAssignmentResponseLateError();
    }

    const workerRes = await tx.query<{ workerContextId: string | null }>(
      `SELECT wc.id AS "workerContextId"
         FROM workforce_profiles fp
         LEFT JOIN handyman_worker_contexts wc
           ON wc.workforce_profile_id = fp.id
          AND wc.client_id = $1
          AND wc.status = 'ACTIVE'
        WHERE fp.user_id = $2
          AND fp.status = 'ACTIVE'
        LIMIT 1`,
      [visit.clientId, actorUserId],
    );
    const respondedByWorkerId = workerRes.rows[0]?.workerContextId ?? null;

    // CR-HM-FIELD-OPS-ACK-01 PART 01 — concurrent-device key guard and the
    // authoritative visit-window expiry guard (after identical replay).
    await assertClientKeyAvailableForAssignment(
      { actorUserId, assignmentId: assignment.id, clientIdempotencyKey: clientKey },
      tx,
    );
    await assertAssignmentResponseWindowOpen(
      {
        assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
        assignmentId: assignment.id,
        visitAppointmentId: visit.id,
      },
      tx,
    );

    const updated = await assignmentResponseRepository.recordDecision(
      {
        assignmentId: assignment.id,
        decision: input.responseStatus,
        actorUserId,
        actorWorkerId: respondedByWorkerId,
        declineReason: normalizedDeclineReason,
        notes: normalizedNotes,
        clientIdempotencyKey: clientKey,
      },
      tx,
    );

    // Explicit acknowledgment / audit trail (PR #58 notification producer is
    // untouched; this is the existing BE-07 operational event store).
    await recordOperationalEvent(
      {
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        entityType: 'HANDYMAN_ASSIGNMENT_RESPONSE',
        entityId: assignment.id,
        actorUserId,
        eventType:
          input.responseStatus === 'TERIMA'
            ? 'HANDYMAN_ASSIGNMENT_ACKNOWLEDGED'
            : 'HANDYMAN_ASSIGNMENT_DECLINED',
        summary:
          input.responseStatus === 'TERIMA'
            ? 'Inspector visit assignment acknowledged (TERIMA)'
            : 'Inspector visit assignment declined (TIDAK_BISA)',
        metadata: {
          assignmentTargetType: 'INSPECTOR_VISIT_ASSIGNMENT',
          assignmentId: assignment.id,
          handymanRequestId: visit.handymanRequestId,
          visitAppointmentId: visit.id,
          responseStatus: input.responseStatus,
          actorWorkerId: respondedByWorkerId,
          declineReason: normalizedDeclineReason,
          clientKeyProvided: clientKey !== null,
          respondedAt: updated.respondedAt?.toISOString() ?? null,
        },
      },
      tx,
    );

    if (input.responseStatus === 'TERIMA') {
      await notifyInspectorAssignmentAccepted(
        {
          clientId: visit.clientId,
          buildingId: visit.buildingId,
          handymanRequestId: visit.handymanRequestId,
          visitAppointmentId: visit.id,
          assignmentId: assignment.id,
          assignedByUserId: assignment.assignedByUserId,
          respondedByUserId: actorUserId,
          respondedByWorkerId,
          respondedAt: updated.respondedAt!,
        },
        tx,
      );
    } else {
      await notifyInspectorAssignmentDeclined(
        {
          clientId: visit.clientId,
          buildingId: visit.buildingId,
          handymanRequestId: visit.handymanRequestId,
          visitAppointmentId: visit.id,
          assignmentId: assignment.id,
          assignedByUserId: assignment.assignedByUserId,
          respondedByUserId: actorUserId,
          respondedByWorkerId,
          respondedAt: updated.respondedAt!,
          declineReason: normalizedDeclineReason!,
        },
        tx,
      );
    }

    return {
      ...toPublic(assignment, updated),
      idempotentReplay: false,
    };
  });
}

export async function listInspectorVisitAssignmentResponseHistory(
  visitAppointmentId: string,
  assignmentId: string,
  actorUserId: string,
): Promise<HandymanInspectorAssignmentResponseHistoryView> {
  const visitId = ensureUuid(visitAppointmentId, 'visitAppointmentId');
  const assignId = ensureUuid(assignmentId, 'assignmentId');
  ensureUuid(actorUserId, 'actorUserId');

  const visit = await handymanInspectorAssignmentRepository.findVisit(
    undefined,
    visitId,
  );
  if (!visit) throw handymanInspectorAssignmentNotFoundError();

  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: visit.clientId,
    buildingId: visit.buildingId,
  });

  const assignment =
    await handymanInspectorAssignmentRepository.findByIdAndVisit(
      undefined,
      assignId,
      visitId,
    );
  if (!assignment) throw handymanInspectorAssignmentNotFoundError();

  const [response, events] = await Promise.all([
    assignmentResponseRepository.findByAssignmentId(assignment.id),
    assignmentResponseRepository.listEventsByAssignmentId(assignment.id),
  ]);

  const responseStatus = response?.responseStatus ?? 'PENDING';
  return {
    assignmentId: assignment.id,
    visitAppointmentId: visit.id,
    handymanRequestId: visit.handymanRequestId,
    inspectorUserId: assignment.inspectorUserId,
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

export const handymanInspectorAssignmentService = {
  assignInspectorToVisit,
  reassignInspectorForVisit,
  revokeInspectorAssignment,
  getInspectorAssignmentForVisit,
  listInspectorAssignmentHistory,
  listEligibleInspectorsForVisit,
  isActiveInspectorForRequest,
  respondToInspectorVisitAssignment,
  listInspectorVisitAssignmentResponseHistory,
};

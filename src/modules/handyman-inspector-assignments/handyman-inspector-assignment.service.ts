import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { canAccessBuildingScopedResource } from '../context-access';
import { findEligibleHandymanWorker } from '../handyman-providers/handyman-worker-eligibility.repository';
import {
  issueInspectorAssignmentResponseTx,
  supersedeAssignmentResponseOnlyTx,
} from '../handyman-assignment-responses/handyman-assignment-response.service';
import { recordOperationalEvent } from '../operational-events';
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
  PublicHandymanInspectorAssignment,
  ReassignHandymanInspectorInput,
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
): PublicHandymanInspectorAssignment {
  return {
    ...record,
    assignedAt: record.assignedAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
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
       JOIN workforce_profiles fp ON fp.user_id = u.id AND fp.status = 'ACTIVE'
        AND fp.workforce_type = 'EXTERNAL'
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

    const priorDeclinedRes = await tx.query<{ id: string }>(
      `SELECT a.id
         FROM handyman_inspector_assignments a
         JOIN handyman_assignment_responses r ON r.assignment_id = a.id
        WHERE a.visit_appointment_id = $1
          AND a.status = 'REVOKED'
          AND r.response_status = 'DECLINED'
          AND r.superseded_by_assignment_id IS NULL
        ORDER BY a.assigned_at DESC, a.id DESC
        LIMIT 1`,
      [visit.id],
    );
    const priorDeclinedId = priorDeclinedRes.rows[0]?.id ?? null;

    const record = await handymanInspectorAssignmentRepository.insert(tx, {
      clientId: visit.clientId,
      handymanRequestId: visit.handymanRequestId,
      visitAppointmentId: visit.id,
      inspectorUserId: inspectorId,
      status: 'ACTIVE',
      assignedByUserId: actorUserId,
      supersedesAssignmentId: priorDeclinedId,
    });
    await journal(
      tx,
      record,
      'HANDYMAN_INSPECTOR_ASSIGNMENT_CREATED',
      `Inspector assigned to inspection visit ${visit.id}.`,
    );
    await issueInspectorAssignmentResponseTx(tx, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      handymanRequestId: visit.handymanRequestId,
      visitAppointmentId: visit.id,
      assignmentId: record.id,
      inspectorUserId: inspectorId,
      assignedByUserId: actorUserId,
      assignedAt: record.assignedAt,
      isReassignment: priorDeclinedId !== null,
      supersededAssignmentId: priorDeclinedId,
    });
    return toPublic(record);
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
    if (!current) {
      const declinedRes = await tx.query<{
        id: string;
        version: number;
      }>(
        `SELECT a.id, a.version
           FROM handyman_inspector_assignments a
           JOIN handyman_assignment_responses r ON r.assignment_id = a.id
          WHERE a.visit_appointment_id = $1
            AND a.status = 'REVOKED'
            AND r.response_status = 'DECLINED'
            AND r.superseded_by_assignment_id IS NULL
          ORDER BY a.assigned_at DESC, a.id DESC
          LIMIT 1
          FOR UPDATE OF a`,
        [visitId],
      );
      const declined = declinedRes.rows[0];
      if (!declined) throw handymanInspectorAssignmentNotFoundError();
      if (
        input.expectedVersion !== declined.version &&
        input.expectedVersion !== declined.version - 1
      ) {
        throw handymanInspectorVersionConflictError();
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
      const record = await handymanInspectorAssignmentRepository.insert(tx, {
        clientId: visit.clientId,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
        inspectorUserId: inspectorId,
        status: 'ACTIVE',
        assignedByUserId: actorUserId,
        supersedesAssignmentId: declined.id,
        reassignmentReason: reason,
      });
      await journal(
        tx,
        record,
        'HANDYMAN_INSPECTOR_ASSIGNMENT_CREATED',
        `Inspector reassigned to visit ${visit.id} (new assignment).`,
      );
      await issueInspectorAssignmentResponseTx(tx, {
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
        assignmentId: record.id,
        inspectorUserId: inspectorId,
        assignedByUserId: actorUserId,
        assignedAt: record.assignedAt,
        isReassignment: true,
        supersededAssignmentId: declined.id,
      });
      return toPublic(record);
    }
    if (current.version !== input.expectedVersion) {
      throw handymanInspectorVersionConflictError();
    }

    // Idempotency guard: same inspector => already current assignment (treat as no-op replay).
    if (current.inspectorUserId === inspectorId) {
      return toPublic(current);
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
    await issueInspectorAssignmentResponseTx(tx, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      handymanRequestId: visit.handymanRequestId,
      visitAppointmentId: visit.id,
      assignmentId: record.id,
      inspectorUserId: inspectorId,
      assignedByUserId: actorUserId,
      assignedAt: record.assignedAt,
      isReassignment: true,
      supersededAssignmentId: current.id,
    });
    return toPublic(record);
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
    await supersedeAssignmentResponseOnlyTx(tx, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      assignmentId: current.id,
      actorUserId,
      notes: `Inspector assignment revoked: ${reasonText}`,
    });
    return toPublic(revoked);
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
  return current ? toPublic(current) : null;
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
  return rows.map(toPublic);
}

/**
 * Helper for field read authority: determine if a user is currently the ACTIVE
 * assigned inspector for a request's latest INSPECTION visit.
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
  if (!assignment) return false;
  return assignment.inspectorUserId === userId;
}

export const handymanInspectorAssignmentService = {
  assignInspectorToVisit,
  reassignInspectorForVisit,
  revokeInspectorAssignment,
  getInspectorAssignmentForVisit,
  listInspectorAssignmentHistory,
  listEligibleInspectorsForVisit,
  isActiveInspectorForRequest,
};

import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import {
  satisfyClockForSubject,
  terminateClocksForSubject,
} from '../applied-slas/sla-clock-lifecycle.service';
import {
  assertBuildingScopedResourceAccess,
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { handymanDispatchRepository } from '../handyman-dispatch/handyman-dispatch.repository';
import { handymanInspectorAssignmentNotFoundError } from '../handyman-inspector-assignments/handyman-inspector-assignment.errors';
import { handymanInspectorAssignmentRepository } from '../handyman-inspector-assignments/handyman-inspector-assignment.repository';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import {
  handymanAssignmentActiveSessionBlockError,
} from '../handyman-scope-assignments/handyman-scope-assignment.errors';
import { handymanScopeAssignmentRepository } from '../handyman-scope-assignments/handyman-scope-assignment.repository';
import { recordOperationalEvent } from '../operational-events';
import { vendorWorkforceRepository } from '../vendor-workforce';
import {
  workOrderExecutionInvalidStateError,
  workOrderExecutionNoAssignmentError,
  workOrderExecutionUnauthorizedError,
} from '../work-order-actions/work-order-action.errors';
import {
  workOrderAssignmentRepository,
  type WorkOrderAssignmentRecord,
} from '../work-order-assignments';
import { recordWorkOrderEvent } from '../work-order-history';
import {
  workOrderNotFoundError,
  workOrderRepository,
  type WorkOrderRecord,
} from '../work-orders';
import { workforceRepository } from '../workforce';
import {
  handymanAssignmentResponseDeadlineInvalidError,
  handymanAssignmentResponseDuplicateError,
  handymanAssignmentResponseExpiredError,
  handymanAssignmentResponseForbiddenError,
  handymanAssignmentSupersededError,
} from './handyman-assignment-response.errors';
import { handymanAssignmentResponseRepository } from './handyman-assignment-response.repository';
import type {
  EffectiveAssignmentDeadlinePolicy,
  HandymanAssignmentResponseEventRecord,
  HandymanAssignmentResponseRecord,
  OperationsAssignmentResponseVisibility,
  PublicAssignmentResponse,
  PublicAssignmentResponseEvent,
} from './handyman-assignment-response.types';

export function toPublicAssignmentResponse(
  record: HandymanAssignmentResponseRecord,
  now: Date = new Date(),
  assignmentIsActive = true,
): PublicAssignmentResponse {
  const isResponseOverdue =
    record.responseStatus === 'PENDING' &&
    assignmentIsActive &&
    now.getTime() > record.responseDeadlineAt.getTime();
  const canRespond =
    record.responseStatus === 'PENDING' &&
    assignmentIsActive &&
    !isResponseOverdue;

  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    assignmentKind: record.assignmentKind,
    assignmentId: record.assignmentId,
    executionScopeId: record.executionScopeId,
    handymanRequestId: record.handymanRequestId,
    visitAppointmentId: record.visitAppointmentId,
    workOrderId: record.workOrderId,
    expectedResponderUserId: record.expectedResponderUserId,
    assignedByUserId: record.assignedByUserId,
    assignedAt: record.assignedAt.toISOString(),
    deadlineMinutes: record.deadlineMinutes,
    responseDeadlineAt: record.responseDeadlineAt.toISOString(),
    isResponseOverdue,
    responseStatus: record.responseStatus,
    responseCode: record.responseCode,
    declineReason: record.declineReason,
    responseNotes: record.responseNotes,
    respondedByUserId: record.respondedByUserId,
    respondedAt: record.respondedAt ? record.respondedAt.toISOString() : null,
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
    supersededByAssignmentId: record.supersededByAssignmentId,
    availableResponseActions: canRespond ? ['ACKNOWLEDGE', 'DECLINE'] : [],
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicAssignmentResponseEvent(
  record: HandymanAssignmentResponseEventRecord,
): PublicAssignmentResponseEvent {
  return {
    ...record,
    occurredAt: record.occurredAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// 1. Configurable Response Deadline Policy (Req 9 — no auto-reassignment)
// ---------------------------------------------------------------------------

export async function getAssignmentDeadlinePolicy(
  actorUserId: string,
  input: { clientId: string; buildingId: string | null },
): Promise<EffectiveAssignmentDeadlinePolicy> {
  if (input.buildingId) {
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: input.clientId,
      buildingId: input.buildingId,
    });
  } else if (
    !(await contextAccessService.canAccessClient(actorUserId, input.clientId))
  ) {
    throw buildingAccessDeniedError();
  }
  return handymanAssignmentResponseRepository.resolveEffectiveDeadlinePolicy(
    undefined,
    input.clientId,
    input.buildingId,
  );
}

export async function configureAssignmentDeadlinePolicy(
  actorUserId: string,
  input: {
    clientId: string;
    buildingId: string | null;
    deadlineMinutes: number;
  },
): Promise<EffectiveAssignmentDeadlinePolicy> {
  if (input.buildingId) {
    // Verify building belongs to client AND actor has exact-Building access.
    const bRes = await getPool().query<{ client_id: string }>(
      `SELECT p.client_id
         FROM buildings b
         JOIN properties p ON p.id = b.property_id
        WHERE b.id = $1`,
      [input.buildingId],
    );
    if (!bRes.rows[0] || bRes.rows[0].client_id !== input.clientId) {
      throw handymanAssignmentResponseDeadlineInvalidError(
        'buildingId does not belong to clientId.',
      );
    }
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: input.clientId,
      buildingId: input.buildingId,
    });
  } else if (
    !(await contextAccessService.canAccessClient(actorUserId, input.clientId))
  ) {
    throw buildingAccessDeniedError();
  }

  return withTransaction(async (tx) => {
    const policy = await handymanAssignmentResponseRepository.upsertDeadlinePolicy(
      tx,
      {
        clientId: input.clientId,
        buildingId: input.buildingId,
        deadlineMinutes: input.deadlineMinutes,
        actorUserId,
      },
    );
    await recordOperationalEvent(
      {
        clientId: input.clientId,
        buildingId: input.buildingId ?? undefined,
        eventType: 'HANDYMAN_ASSIGNMENT_RESPONSE_DEADLINE_CONFIGURED',
        entityType: 'HANDYMAN_ASSIGNMENT_RESPONSE_POLICY',
        entityId: input.buildingId ?? input.clientId,
        actorUserId,
        summary: `Configured assignment response deadline to ${input.deadlineMinutes} minutes (autoReassignEnabled=false).`,
        metadata: {
          clientId: input.clientId,
          buildingId: input.buildingId,
          deadlineMinutes: input.deadlineMinutes,
          autoReassignEnabled: false,
        },
      },
      tx,
    );
    return policy;
  });
}

// ---------------------------------------------------------------------------
// 2. Issuance & Reassignment Hooks (IN_APP notification + PENDING envelope)
// ---------------------------------------------------------------------------

/**
 * Called atomically inside `assignHandymanExecutionScopeCrew` and
 * `reassignHandymanExecutionScopeCrew`.
 */
export async function issueExecutionScopeAssignmentResponseTx(
  tx: PoolClient,
  input: {
    clientId: string;
    buildingId: string;
    executionScopeId: string;
    assignmentId: string;
    crewId: string;
    leadUserId: string;
    assignedByUserId: string;
    assignedAt: Date;
    isReassignment: boolean;
    supersededAssignmentId?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<HandymanAssignmentResponseRecord> {
  const scopeMeta = await tx.query<{
    handyman_request_id: string;
    description: string | null;
  }>(
    `SELECT es.handyman_request_id, r.description
       FROM handyman_execution_scopes es
       JOIN handyman_service_requests r
         ON r.id = es.handyman_request_id AND r.client_id = es.client_id
      WHERE es.id = $1`,
    [input.executionScopeId],
  );
  const handymanRequestId = scopeMeta.rows[0]?.handyman_request_id ?? null;
  const description = scopeMeta.rows[0]?.description ?? null;

  if (input.supersededAssignmentId) {
    const prev = await handymanAssignmentResponseRepository.markAssignmentSuperseded(
      tx,
      input.supersededAssignmentId,
      input.assignmentId,
    );
    if (prev) {
      await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
        clientId: input.clientId,
        buildingId: input.buildingId,
        assignmentResponseId: prev.id,
        assignmentKind: 'EXECUTION_SCOPE_CREW',
        assignmentId: prev.assignmentId,
        executionScopeId: input.executionScopeId,
        handymanRequestId,
        eventType: 'ASSIGNMENT_SUPERSEDED',
        responseStatus: prev.responseStatus,
        responseCode: prev.responseCode,
        notes: `Superseded by assignment ${input.assignmentId}`,
        actorUserId: input.assignedByUserId,
      });
    }
  }

  const policy = await handymanAssignmentResponseRepository.resolveEffectiveDeadlinePolicy(
    tx,
    input.clientId,
    input.buildingId,
  );
  const response = await handymanAssignmentResponseRepository.insertPendingResponse(
    tx,
    {
      clientId: input.clientId,
      buildingId: input.buildingId,
      assignmentKind: 'EXECUTION_SCOPE_CREW',
      assignmentId: input.assignmentId,
      executionScopeId: input.executionScopeId,
      handymanRequestId,
      expectedResponderUserId: input.leadUserId,
      assignedByUserId: input.assignedByUserId,
      assignedAt: input.assignedAt,
      deadlineMinutes: policy.deadlineMinutes,
    },
  );
  await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
    clientId: input.clientId,
    buildingId: input.buildingId,
    assignmentResponseId: response.id,
    assignmentKind: 'EXECUTION_SCOPE_CREW',
    assignmentId: input.assignmentId,
    executionScopeId: input.executionScopeId,
    handymanRequestId,
    eventType: 'ASSIGNMENT_ISSUED',
    responseStatus: 'PENDING',
    actorUserId: input.assignedByUserId,
    idempotencyKey: input.idempotencyKey ?? null,
  });

  const sourceEventType = input.isReassignment
    ? 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_REASSIGNED'
    : 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_CREATED';

  await handymanAssignmentResponseRepository.emitTargetedInAppNotificationTx(
    tx,
    {
      clientId: input.clientId,
      buildingId: input.buildingId,
      recipientUserId: input.leadUserId,
      type: 'HANDYMAN_ASSIGNMENT_ISSUED',
      title: input.isReassignment
        ? 'Penugasan Pekerjaan Handyman Baru (Reassignment)'
        : 'Penugasan Pekerjaan Handyman Baru',
      body: description
        ? `Anda ditugaskan sebagai Crew Lead untuk pekerjaan: ${description.slice(0, 160)}. Mohon konfirmasi TERIMA atau TIDAK BISA sebelum batas waktu.`
        : 'Anda ditugaskan sebagai Crew Lead untuk pekerjaan Handyman baru. Mohon konfirmasi TERIMA atau TIDAK BISA sebelum batas waktu.',
      sourceEntityType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
      sourceEntityId: input.assignmentId,
      sourceEventType,
      metadata: {
        assignmentKind: 'EXECUTION_SCOPE_CREW',
        assignmentId: input.assignmentId,
        executionScopeId: input.executionScopeId,
        handymanRequestId,
        buildingId: input.buildingId,
        crewId: input.crewId,
        responseStatus: 'PENDING',
        responseDeadlineAt: response.responseDeadlineAt.toISOString(),
        availableResponseActions: ['ACKNOWLEDGE', 'DECLINE'],
      },
      navigationTarget: null,
      enqueuePushIfRegistered: true,
    },
  );

  return response;
}

/**
 * Called atomically inside `assignInspectorToVisit`, `reassignInspectorForVisit`,
 * and `revokeInspectorAssignment`.
 */
export async function issueInspectorAssignmentResponseTx(
  tx: PoolClient,
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    visitAppointmentId: string;
    assignmentId: string;
    inspectorUserId: string;
    assignedByUserId: string;
    assignedAt: Date;
    isReassignment: boolean;
    supersededAssignmentId?: string | null;
  },
): Promise<HandymanAssignmentResponseRecord> {
  if (input.supersededAssignmentId) {
    const prev = await handymanAssignmentResponseRepository.markAssignmentSuperseded(
      tx,
      input.supersededAssignmentId,
      input.assignmentId,
    );
    if (prev) {
      await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
        clientId: input.clientId,
        buildingId: input.buildingId,
        assignmentResponseId: prev.id,
        assignmentKind: 'INSPECTION_VISIT',
        assignmentId: prev.assignmentId,
        handymanRequestId: input.handymanRequestId,
        visitAppointmentId: input.visitAppointmentId,
        eventType: 'ASSIGNMENT_SUPERSEDED',
        responseStatus: prev.responseStatus,
        responseCode: prev.responseCode,
        notes: `Superseded by inspector assignment ${input.assignmentId}`,
        actorUserId: input.assignedByUserId,
      });
    }
  }

  const policy = await handymanAssignmentResponseRepository.resolveEffectiveDeadlinePolicy(
    tx,
    input.clientId,
    input.buildingId,
  );
  const response = await handymanAssignmentResponseRepository.insertPendingResponse(
    tx,
    {
      clientId: input.clientId,
      buildingId: input.buildingId,
      assignmentKind: 'INSPECTION_VISIT',
      assignmentId: input.assignmentId,
      handymanRequestId: input.handymanRequestId,
      visitAppointmentId: input.visitAppointmentId,
      expectedResponderUserId: input.inspectorUserId,
      assignedByUserId: input.assignedByUserId,
      assignedAt: input.assignedAt,
      deadlineMinutes: policy.deadlineMinutes,
    },
  );
  await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
    clientId: input.clientId,
    buildingId: input.buildingId,
    assignmentResponseId: response.id,
    assignmentKind: 'INSPECTION_VISIT',
    assignmentId: input.assignmentId,
    handymanRequestId: input.handymanRequestId,
    visitAppointmentId: input.visitAppointmentId,
    eventType: 'ASSIGNMENT_ISSUED',
    responseStatus: 'PENDING',
    actorUserId: input.assignedByUserId,
  });

  const sourceEventType = input.isReassignment
    ? 'HANDYMAN_INSPECTOR_ASSIGNMENT_REASSIGNED'
    : 'HANDYMAN_INSPECTOR_ASSIGNMENT_CREATED';

  await handymanAssignmentResponseRepository.emitTargetedInAppNotificationTx(
    tx,
    {
      clientId: input.clientId,
      buildingId: input.buildingId,
      recipientUserId: input.inspectorUserId,
      type: 'HANDYMAN_INSPECTOR_ASSIGNMENT_ISSUED',
      title: input.isReassignment
        ? 'Penugasan Inspeksi Handyman Baru (Reassignment)'
        : 'Penugasan Inspeksi Handyman Baru',
      body: 'Anda ditugaskan untuk kunjungan inspeksi Handyman. Mohon konfirmasi TERIMA atau TIDAK BISA sebelum batas waktu.',
      sourceEntityType: 'HANDYMAN_INSPECTOR_ASSIGNMENT',
      sourceEntityId: input.assignmentId,
      sourceEventType,
      metadata: {
        assignmentKind: 'INSPECTION_VISIT',
        assignmentId: input.assignmentId,
        visitAppointmentId: input.visitAppointmentId,
        handymanRequestId: input.handymanRequestId,
        buildingId: input.buildingId,
        responseStatus: 'PENDING',
        responseDeadlineAt: response.responseDeadlineAt.toISOString(),
        availableResponseActions: ['ACKNOWLEDGE', 'DECLINE'],
      },
      navigationTarget: null,
      enqueuePushIfRegistered: true,
    },
  );

  return response;
}

export async function supersedeAssignmentResponseOnlyTx(
  tx: PoolClient,
  input: {
    clientId: string;
    buildingId: string;
    assignmentId: string;
    actorUserId: string;
    notes?: string;
  },
): Promise<void> {
  const prev = await handymanAssignmentResponseRepository.markAssignmentSuperseded(
    tx,
    input.assignmentId,
    null,
  );
  if (prev) {
    await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
      clientId: input.clientId,
      buildingId: input.buildingId,
      assignmentResponseId: prev.id,
      assignmentKind: prev.assignmentKind,
      assignmentId: prev.assignmentId,
      executionScopeId: prev.executionScopeId,
      handymanRequestId: prev.handymanRequestId,
      visitAppointmentId: prev.visitAppointmentId,
      workOrderId: prev.workOrderId,
      eventType: 'ASSIGNMENT_SUPERSEDED',
      responseStatus: prev.responseStatus,
      responseCode: prev.responseCode,
      notes: input.notes ?? 'Assignment revoked or deactivated',
      actorUserId: input.actorUserId,
    });
  }
}

/**
 * Resolves exact worker userIds for a `work_order_assignments` row (supporting
 * permanent `INTERNAL`, `CONTRACT`, `OUTSOURCED`, direct freelance `EXTERNAL`,
 * `VENDOR_WORKFORCE`, `TEAM`, and `VENDOR`). Never includes unassigned workers.
 */
async function resolveWorkOrderAssignmentRecipientUserIds(
  executor: Pick<PoolClient, 'query'>,
  assignment: WorkOrderAssignmentRecord,
  buildingId: string,
): Promise<{ primaryUserId: string | null; recipientUserIds: string[] }> {
  if (
    assignment.assigneeType === 'WORKFORCE' ||
    assignment.assigneeType === 'VENDOR_WORKFORCE'
  ) {
    if (!assignment.workforceProfileId) {
      return { primaryUserId: null, recipientUserIds: [] };
    }
    const res = await executor.query<{ user_id: string | null }>(
      `SELECT wp.user_id
         FROM workforce_profiles wp
         LEFT JOIN users u ON u.id = wp.user_id
        WHERE wp.id = $1
          AND wp.status = 'ACTIVE'
          AND (wp.user_id IS NULL OR u.status = 'ACTIVE')
        LIMIT 1`,
      [assignment.workforceProfileId],
    );
    const uid = res.rows[0]?.user_id ?? null;
    return {
      primaryUserId: uid,
      recipientUserIds: uid ? [uid] : [],
    };
  }

  if (assignment.assigneeType === 'TEAM' && assignment.teamId) {
    const res = await executor.query<{ user_id: string }>(
      `SELECT DISTINCT wp.user_id
         FROM workforce_profiles wp
         JOIN users u ON u.id = wp.user_id AND u.status = 'ACTIVE'
         JOIN user_building_assignments uba
           ON uba.user_id = u.id
          AND uba.building_id = $2
          AND uba.status = 'ACTIVE'
        WHERE wp.team_id = $1
          AND wp.status = 'ACTIVE'
          AND wp.user_id IS NOT NULL
        ORDER BY wp.user_id ASC`,
      [assignment.teamId, buildingId],
    );
    const ids = res.rows.map((r) => r.user_id);
    return {
      primaryUserId: ids.length === 1 ? ids[0] : null,
      recipientUserIds: ids,
    };
  }

  if (assignment.assigneeType === 'VENDOR' && assignment.vendorId) {
    const res = await executor.query<{ user_id: string }>(
      `SELECT DISTINCT wp.user_id
         FROM vendor_workforce_bindings vwb
         JOIN workforce_profiles wp ON wp.id = vwb.workforce_profile_id AND wp.status = 'ACTIVE'
         JOIN users u ON u.id = wp.user_id AND u.status = 'ACTIVE'
         JOIN user_building_assignments uba
           ON uba.user_id = u.id
          AND uba.building_id = $2
          AND uba.status = 'ACTIVE'
        WHERE vwb.vendor_id = $1
          AND vwb.status = 'ACTIVE'
          AND wp.user_id IS NOT NULL
        ORDER BY wp.user_id ASC`,
      [assignment.vendorId, buildingId],
    );
    const ids = res.rows.map((r) => r.user_id);
    return {
      primaryUserId: ids.length === 1 ? ids[0] : null,
      recipientUserIds: ids,
    };
  }

  return { primaryUserId: null, recipientUserIds: [] };
}

/**
 * Called when a Work Order is assigned or reassigned (`work-order-assignments`).
 * Emits `IN_APP` notification(s) with canonical `WORK_ORDER_FIELD_WORK`
 * navigationTarget to the exact assigned worker(s).
 */
export async function issueWorkOrderAssignmentResponse(
  input: {
    clientId: string;
    buildingId: string;
    workOrderId: string;
    workOrderNumber: string;
    workOrderTitle: string;
    assignment: WorkOrderAssignmentRecord;
    isReassignment: boolean;
    supersededAssignmentId?: string | null;
  },
): Promise<HandymanAssignmentResponseRecord> {
  return withTransaction(async (tx) => {
    if (input.supersededAssignmentId) {
      const prev =
        await handymanAssignmentResponseRepository.markAssignmentSuperseded(
          tx,
          input.supersededAssignmentId,
          input.assignment.id,
        );
      if (prev) {
        await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
          clientId: input.clientId,
          buildingId: input.buildingId,
          assignmentResponseId: prev.id,
          assignmentKind: 'WORK_ORDER',
          assignmentId: prev.assignmentId,
          workOrderId: input.workOrderId,
          eventType: 'ASSIGNMENT_SUPERSEDED',
          responseStatus: prev.responseStatus,
          responseCode: prev.responseCode,
          notes: `Superseded by work order assignment ${input.assignment.id}`,
          actorUserId: input.assignment.assignedByUserId,
        });
      }
    }

    const { primaryUserId, recipientUserIds } =
      await resolveWorkOrderAssignmentRecipientUserIds(
        tx,
        input.assignment,
        input.buildingId,
      );

    const policy =
      await handymanAssignmentResponseRepository.resolveEffectiveDeadlinePolicy(
        tx,
        input.clientId,
        input.buildingId,
      );
    const response =
      await handymanAssignmentResponseRepository.insertPendingResponse(tx, {
        clientId: input.clientId,
        buildingId: input.buildingId,
        assignmentKind: 'WORK_ORDER',
        assignmentId: input.assignment.id,
        workOrderId: input.workOrderId,
        expectedResponderUserId: primaryUserId,
        assignedByUserId: input.assignment.assignedByUserId,
        assignedAt: input.assignment.assignedAt,
        deadlineMinutes: policy.deadlineMinutes,
      });
    await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
      clientId: input.clientId,
      buildingId: input.buildingId,
      assignmentResponseId: response.id,
      assignmentKind: 'WORK_ORDER',
      assignmentId: input.assignment.id,
      workOrderId: input.workOrderId,
      eventType: 'ASSIGNMENT_ISSUED',
      responseStatus: 'PENDING',
      actorUserId: input.assignment.assignedByUserId,
    });

    const sourceEventType = input.isReassignment
      ? 'WORK_ORDER_REASSIGNED'
      : 'WORK_ORDER_ASSIGNED';

    for (const recipientUserId of recipientUserIds) {
      await handymanAssignmentResponseRepository.emitTargetedInAppNotificationTx(
        tx,
        {
          clientId: input.clientId,
          buildingId: input.buildingId,
          recipientUserId,
          type: 'WORK_ORDER_ASSIGNMENT_ISSUED',
          title: input.isReassignment
            ? `Penugasan Work Order ${input.workOrderNumber} (Reassignment)`
            : `Penugasan Work Order Baru ${input.workOrderNumber}`,
          body: `Anda ditugaskan pada Work Order "${input.workOrderTitle.slice(0, 140)}". Mohon konfirmasi TERIMA (Acknowledge) atau TIDAK BISA sebelum batas waktu.`,
          sourceEntityType: 'WORK_ORDER_ASSIGNMENT',
          sourceEntityId: input.assignment.id,
          sourceEventType,
          metadata: {
            assignmentKind: 'WORK_ORDER',
            assignmentId: input.assignment.id,
            workOrderId: input.workOrderId,
            workOrderNumber: input.workOrderNumber,
            buildingId: input.buildingId,
            responseStatus: 'PENDING',
            responseDeadlineAt: response.responseDeadlineAt.toISOString(),
            availableResponseActions: ['ACKNOWLEDGE', 'DECLINE'],
          },
          navigationTarget: {
            type: 'WORK_ORDER_FIELD_WORK',
            id: input.workOrderId,
          },
          enqueuePushIfRegistered: true,
        },
      );
    }

    return response;
  });
}

// ---------------------------------------------------------------------------
// 3. Crew Lead (`PIC_PEKERJAAN`) Execution Scope Response: ACKNOWLEDGE / DECLINE
// ---------------------------------------------------------------------------

async function resolveCurrentScopeCrewLeadUserId(
  tx: PoolClient,
  scope: { id: string; clientId: string; buildingId: string },
  assignment: { id: string; handymanProviderContextId: string; handymanCrewId: string },
): Promise<string | null> {
  const res = await tx.query<{ user_id: string }>(
    `SELECT wp.user_id
       FROM handyman_work_crews crew
       JOIN LATERAL (
         SELECT cl.handyman_crew_membership_id
           FROM handyman_crew_leads cl
          WHERE cl.handyman_crew_id = crew.id
          ORDER BY cl.lead_seq DESC
          LIMIT 1
       ) lead ON TRUE
       JOIN handyman_crew_memberships cm
         ON cm.id = lead.handyman_crew_membership_id
        AND cm.handyman_crew_id = crew.id
        AND cm.client_id = $1
        AND cm.status = 'ACTIVE'
       JOIN handyman_worker_contexts wc
         ON wc.id = cm.handyman_worker_context_id
        AND wc.client_id = $1
        AND wc.handyman_provider_context_id = $3
        AND wc.status = 'ACTIVE'
       JOIN workforce_profiles wp
         ON wp.id = wc.workforce_profile_id
        AND wp.status = 'ACTIVE'
        AND wp.user_id IS NOT NULL
       JOIN users u
         ON u.id = wp.user_id
        AND u.status = 'ACTIVE'
      WHERE crew.id = $2
        AND crew.client_id = $1
        AND crew.handyman_provider_context_id = $3
        AND crew.status = 'ACTIVE'
      LIMIT 1`,
    [
      scope.clientId,
      assignment.handymanCrewId,
      assignment.handymanProviderContextId,
    ],
  );
  return res.rows[0]?.user_id ?? null;
}

async function assertScopeResponderOrThrow(
  tx: PoolClient,
  scope: { id: string; clientId: string; buildingId: string },
  actorUserId: string,
  requestedAssignmentId?: string,
) {
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  });

  // If caller explicitly referenced an assignmentId, check if it was superseded or declined.
  if (requestedAssignmentId) {
    const refAssign = await tx.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM handyman_execution_scope_assignments
        WHERE id = $1 AND execution_scope_id = $2`,
      [requestedAssignmentId, scope.id],
    );
    if (!refAssign.rows[0]) {
      throw handymanAssignmentResponseForbiddenError();
    }
    if (refAssign.rows[0].status === 'SUPERSEDED') {
      const refResp =
        await handymanAssignmentResponseRepository.findByAssignmentId(
          tx,
          requestedAssignmentId,
        );
      if (refResp && refResp.responseStatus === 'DECLINED' && !refResp.supersededByAssignmentId) {
        throw handymanAssignmentResponseDuplicateError();
      }
      throw handymanAssignmentSupersededError();
    }
  }

  const active = await handymanScopeAssignmentRepository.lockActiveAssignmentByScope(
    tx,
    scope.id,
  );
  if (!active) {
    // Check if the actor previously responded DECLINED (duplicate) or was superseded!
    const prior = await tx.query<{
      assignment_id: string;
      response_status: string;
      superseded_by_assignment_id: string | null;
      expected_responder_user_id: string | null;
      responded_by_user_id: string | null;
    }>(
      `SELECT assignment_id, response_status, superseded_by_assignment_id,
              expected_responder_user_id, responded_by_user_id
         FROM handyman_assignment_responses
        WHERE client_id = $1 AND execution_scope_id = $2
        ORDER BY assigned_at DESC, id DESC`,
      [scope.clientId, scope.id],
    );
    const actorPrior = prior.rows.find(
      (r) =>
        r.expected_responder_user_id === actorUserId ||
        r.responded_by_user_id === actorUserId,
    );
    if (actorPrior) {
      if (
        actorPrior.response_status === 'DECLINED' &&
        !actorPrior.superseded_by_assignment_id
      ) {
        throw handymanAssignmentResponseDuplicateError();
      }
      throw handymanAssignmentSupersededError();
    }
    throw handymanAssignmentResponseForbiddenError(
      'No active crew assignment exists on this execution scope.',
    );
  }

  const currentLeadUserId = await resolveCurrentScopeCrewLeadUserId(
    tx,
    scope,
    active,
  );

  if (!currentLeadUserId || currentLeadUserId !== actorUserId) {
    // Distinguish a replaced/superseded prior Crew Lead (409) from an
    // unassigned worker or non-Lead helper (403).
    const wasSupersededLead = await tx.query<{ id: string }>(
      `SELECT r.id
         FROM handyman_assignment_responses r
        WHERE r.client_id = $1
          AND r.execution_scope_id = $2
          AND r.assignment_id <> $3
          AND (r.expected_responder_user_id = $4 OR r.responded_by_user_id = $4)
        LIMIT 1`,
      [scope.clientId, scope.id, active.id, actorUserId],
    );
    if (wasSupersededLead.rows.length > 0) {
      throw handymanAssignmentSupersededError();
    }
    throw handymanAssignmentResponseForbiddenError();
  }

  let responseRow = await handymanAssignmentResponseRepository.lockByAssignmentId(
    tx,
    active.id,
  );
  if (!responseRow) {
    const policy =
      await handymanAssignmentResponseRepository.resolveEffectiveDeadlinePolicy(
        tx,
        scope.clientId,
        scope.buildingId,
      );
    responseRow =
      await handymanAssignmentResponseRepository.insertPendingResponse(tx, {
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        assignmentKind: 'EXECUTION_SCOPE_CREW',
        assignmentId: active.id,
        executionScopeId: scope.id,
        expectedResponderUserId: currentLeadUserId,
        assignedByUserId: active.assignedByUserId,
        assignedAt: active.assignedAt,
        deadlineMinutes: policy.deadlineMinutes,
      });
  }

  if (responseRow.responseStatus !== 'PENDING') {
    if (responseRow.responseStatus === 'SUPERSEDED') {
      throw handymanAssignmentSupersededError();
    }
    throw handymanAssignmentResponseDuplicateError();
  }

  const now = await handymanAssignmentResponseRepository.getServerNow(tx);
  if (now.getTime() > responseRow.responseDeadlineAt.getTime()) {
    throw handymanAssignmentResponseExpiredError(
      responseRow.responseDeadlineAt.toISOString(),
    );
  }

  return { active, responseRow, now };
}

export async function acknowledgeExecutionScopeAssignment(
  executionScopeId: string,
  actorUserId: string,
  input: { assignmentId?: string; notes?: string; idempotencyKey?: string },
): Promise<PublicAssignmentResponse> {
  return withTransaction(async (tx) => {
    const scope = await handymanScopeAssignmentRepository.lockScopeById(
      tx,
      executionScopeId,
    );
    if (!scope) throw handymanExecutionScopeNotFoundError();

    const { active, responseRow } = await assertScopeResponderOrThrow(
      tx,
      scope,
      actorUserId,
      input.assignmentId,
    );

    const updated = await handymanAssignmentResponseRepository.markAccepted(
      tx,
      responseRow.id,
      actorUserId,
      input.notes ?? null,
    );
    if (!updated) throw handymanAssignmentResponseDuplicateError();

    await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
      assignmentResponseId: updated.id,
      assignmentKind: 'EXECUTION_SCOPE_CREW',
      assignmentId: active.id,
      executionScopeId: scope.id,
      handymanRequestId: updated.handymanRequestId,
      eventType: 'ACKNOWLEDGED_TERIMA',
      responseStatus: 'ACCEPTED',
      responseCode: 'TERIMA',
      notes: input.notes ?? null,
      actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    // Satisfy Handyman assignment RESPONSE SLA clock when present (CR-HM-16 reuse).
    await satisfyClockForSubject(
      {
        subjectType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
        subjectId: active.id,
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        workType: null,
        priority: null,
      },
      'RESPONSE',
      updated.respondedAt!,
      tx,
    );

    await recordOperationalEvent(
      {
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        eventType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_ACKNOWLEDGED',
        entityType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
        entityId: active.id,
        actorUserId,
        summary: 'Crew Lead acknowledged (TERIMA) Handyman execution scope assignment.',
        metadata: {
          assignmentId: active.id,
          executionScopeId: scope.id,
          crewId: active.handymanCrewId,
          responseStatus: 'ACCEPTED',
          responseCode: 'TERIMA',
          respondedAt: updated.respondedAt!.toISOString(),
        },
      },
      tx,
    );

    const now = await handymanAssignmentResponseRepository.getServerNow(tx);
    return toPublicAssignmentResponse(updated, now, true);
  });
}

export async function declineExecutionScopeAssignment(
  executionScopeId: string,
  actorUserId: string,
  input: {
    assignmentId?: string;
    reason: string;
    notes?: string;
    idempotencyKey?: string;
  },
): Promise<PublicAssignmentResponse> {
  return withTransaction(async (tx) => {
    const scope = await handymanScopeAssignmentRepository.lockScopeById(
      tx,
      executionScopeId,
    );
    if (!scope) throw handymanExecutionScopeNotFoundError();

    if (
      await handymanScopeAssignmentRepository.checkActiveWorkSession(
        tx,
        executionScopeId,
      )
    ) {
      throw handymanAssignmentActiveSessionBlockError();
    }

    const { active, responseRow } = await assertScopeResponderOrThrow(
      tx,
      scope,
      actorUserId,
      input.assignmentId,
    );

    const updated = await handymanAssignmentResponseRepository.markDeclined(
      tx,
      responseRow.id,
      actorUserId,
      input.reason,
      input.notes ?? null,
    );
    if (!updated) throw handymanAssignmentResponseDuplicateError();

    await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
      clientId: scope.clientId,
      buildingId: scope.buildingId,
      assignmentResponseId: updated.id,
      assignmentKind: 'EXECUTION_SCOPE_CREW',
      assignmentId: active.id,
      executionScopeId: scope.id,
      handymanRequestId: updated.handymanRequestId,
      eventType: 'DECLINED_TIDAK_BISA',
      responseStatus: 'DECLINED',
      responseCode: 'TIDAK_BISA',
      reason: input.reason,
      notes: input.notes ?? null,
      actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    // Supersede any RELEASED dispatch release BEFORE superseding the assignment
    // (0441 trigger requires assignment ACTIVE when superseding dispatch).
    await handymanDispatchRepository.supersedeForAssignment(
      tx,
      active.id,
      actorUserId,
      `Assignment declined (TIDAK_BISA): ${input.reason}`,
    );

    // Revoke Crew Lead's assignment authority (ACTIVE -> SUPERSEDED) WITHOUT
    // cancelling the Tenant Request or Execution Scope (`scope.status` stays AUTHORIZED).
    const superseded =
      await handymanScopeAssignmentRepository.supersedeAssignment(
        tx,
        active.id,
        active.version,
      );
    if (!superseded) {
      throw handymanAssignmentSupersededError();
    }

    await handymanScopeAssignmentRepository.insertAssignmentHistory(tx, {
      clientId: scope.clientId,
      assignmentId: active.id,
      executionScopeId: scope.id,
      fromProviderContextId: active.handymanProviderContextId,
      fromCrewId: active.handymanCrewId,
      toProviderContextId: active.handymanProviderContextId,
      toCrewId: active.handymanCrewId,
      action: 'REVOKED',
      reason: `TIDAK_BISA: ${input.reason}`.slice(0, 1000),
      expectedVersion: active.version,
      priorVersion: active.version,
      actorUserId,
      idempotencyKey: null,
    });

    await terminateClocksForSubject(
      {
        subjectType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
        subjectId: active.id,
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        workType: null,
        priority: null,
      },
      updated.respondedAt!,
      tx,
    );

    await recordOperationalEvent(
      {
        clientId: scope.clientId,
        buildingId: scope.buildingId,
        eventType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_DECLINED',
        entityType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
        entityId: active.id,
        actorUserId,
        summary: `Crew Lead declined (TIDAK_BISA) assignment: ${input.reason}`,
        metadata: {
          assignmentId: active.id,
          executionScopeId: scope.id,
          handymanRequestId: updated.handymanRequestId,
          crewId: active.handymanCrewId,
          responseStatus: 'DECLINED',
          responseCode: 'TIDAK_BISA',
          reason: input.reason,
          respondedAt: updated.respondedAt!.toISOString(),
          requiresReassignment: true,
          tenantWorkOrderCancelled: false,
        },
      },
      tx,
    );

    // Notify Operations (`assignedByUserId` + Building Operations managers) via IN_APP.
    const opsRecipients =
      await handymanAssignmentResponseRepository.resolveOperationsDeclineRecipients(
        tx,
        {
          clientId: scope.clientId,
          buildingId: scope.buildingId,
          assignedByUserId: active.assignedByUserId,
          excludeUserId: actorUserId,
          permissionCode: 'tenant_company.manage',
        },
      );

    for (const opsUserId of opsRecipients) {
      await handymanAssignmentResponseRepository.emitTargetedInAppNotificationTx(
        tx,
        {
          clientId: scope.clientId,
          buildingId: scope.buildingId,
          recipientUserId: opsUserId,
          type: 'HANDYMAN_ASSIGNMENT_DECLINED_OPERATIONS_ACTION_REQUIRED',
          title: 'Petugas Menolak Penugasan (TIDAK BISA) — Perlu Reassignment',
          body: `Crew Lead menyatakan TIDAK BISA untuk penugasan pekerjaan. Alasan: ${input.reason.slice(0, 180)}`,
          sourceEntityType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT',
          sourceEntityId: active.id,
          sourceEventType: 'HANDYMAN_EXECUTION_SCOPE_ASSIGNMENT_DECLINED',
          metadata: {
            assignmentKind: 'EXECUTION_SCOPE_CREW',
            assignmentId: active.id,
            assignmentVersion: superseded.version,
            executionScopeId: scope.id,
            handymanRequestId: updated.handymanRequestId,
            buildingId: scope.buildingId,
            declinedByUserId: actorUserId,
            responseStatus: 'DECLINED',
            responseCode: 'TIDAK_BISA',
            reason: input.reason,
            respondedAt: updated.respondedAt!.toISOString(),
            requiresReassignment: true,
          },
          navigationTarget: null,
          enqueuePushIfRegistered: true,
        },
      );
    }

    const now = await handymanAssignmentResponseRepository.getServerNow(tx);
    return toPublicAssignmentResponse(updated, now, false);
  });
}

// ---------------------------------------------------------------------------
// 4. Inspector Visit Assignment Response: ACKNOWLEDGE / DECLINE
// ---------------------------------------------------------------------------

async function assertInspectorResponderOrThrow(
  tx: PoolClient,
  visit: {
    id: string;
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    state: string;
  },
  actorUserId: string,
  requestedAssignmentId?: string,
) {
  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: visit.clientId,
    buildingId: visit.buildingId,
  });

  if (requestedAssignmentId) {
    const refAssign = await tx.query<{ id: string; status: string }>(
      `SELECT id, status
         FROM handyman_inspector_assignments
        WHERE id = $1 AND visit_appointment_id = $2`,
      [requestedAssignmentId, visit.id],
    );
    if (!refAssign.rows[0]) {
      throw handymanAssignmentResponseForbiddenError();
    }
    if (refAssign.rows[0].status !== 'ACTIVE') {
      const refResp =
        await handymanAssignmentResponseRepository.findByAssignmentId(
          tx,
          requestedAssignmentId,
        );
      if (refResp && refResp.responseStatus === 'DECLINED' && !refResp.supersededByAssignmentId) {
        throw handymanAssignmentResponseDuplicateError();
      }
      throw handymanAssignmentSupersededError();
    }
  }

  const active =
    await handymanInspectorAssignmentRepository.lockActiveByVisit(tx, visit.id);
  if (!active) {
    const prior = await tx.query<{
      response_status: string;
      superseded_by_assignment_id: string | null;
      expected_responder_user_id: string | null;
      responded_by_user_id: string | null;
    }>(
      `SELECT response_status, superseded_by_assignment_id,
              expected_responder_user_id, responded_by_user_id
         FROM handyman_assignment_responses
        WHERE client_id = $1 AND visit_appointment_id = $2
        ORDER BY assigned_at DESC, id DESC`,
      [visit.clientId, visit.id],
    );
    const actorPrior = prior.rows.find(
      (r) =>
        r.expected_responder_user_id === actorUserId ||
        r.responded_by_user_id === actorUserId,
    );
    if (actorPrior) {
      if (
        actorPrior.response_status === 'DECLINED' &&
        !actorPrior.superseded_by_assignment_id
      ) {
        throw handymanAssignmentResponseDuplicateError();
      }
      throw handymanAssignmentSupersededError();
    }
    throw handymanAssignmentResponseForbiddenError(
      'No active inspector assignment exists for this visit.',
    );
  }

  if (active.inspectorUserId !== actorUserId) {
    const wasPriorInspector = await tx.query<{ id: string }>(
      `SELECT id
         FROM handyman_inspector_assignments
        WHERE visit_appointment_id = $1
          AND id <> $2
          AND inspector_user_id = $3
        LIMIT 1`,
      [visit.id, active.id, actorUserId],
    );
    if (wasPriorInspector.rows.length > 0) {
      throw handymanAssignmentSupersededError();
    }
    throw handymanAssignmentResponseForbiddenError();
  }

  let responseRow = await handymanAssignmentResponseRepository.lockByAssignmentId(
    tx,
    active.id,
  );
  if (!responseRow) {
    const policy =
      await handymanAssignmentResponseRepository.resolveEffectiveDeadlinePolicy(
        tx,
        visit.clientId,
        visit.buildingId,
      );
    responseRow =
      await handymanAssignmentResponseRepository.insertPendingResponse(tx, {
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        assignmentKind: 'INSPECTION_VISIT',
        assignmentId: active.id,
        handymanRequestId: visit.handymanRequestId,
        visitAppointmentId: visit.id,
        expectedResponderUserId: active.inspectorUserId,
        assignedByUserId: active.assignedByUserId,
        assignedAt: active.assignedAt,
        deadlineMinutes: policy.deadlineMinutes,
      });
  }

  if (responseRow.responseStatus !== 'PENDING') {
    if (responseRow.responseStatus === 'SUPERSEDED') {
      throw handymanAssignmentSupersededError();
    }
    throw handymanAssignmentResponseDuplicateError();
  }

  const now = await handymanAssignmentResponseRepository.getServerNow(tx);
  if (now.getTime() > responseRow.responseDeadlineAt.getTime()) {
    throw handymanAssignmentResponseExpiredError(
      responseRow.responseDeadlineAt.toISOString(),
    );
  }

  return { active, responseRow, now };
}

export async function acknowledgeInspectorVisitAssignment(
  visitAppointmentId: string,
  actorUserId: string,
  input: { assignmentId?: string; notes?: string; idempotencyKey?: string },
): Promise<PublicAssignmentResponse> {
  return withTransaction(async (tx) => {
    const visit = await handymanInspectorAssignmentRepository.lockVisit(
      tx,
      visitAppointmentId,
    );
    if (!visit) throw handymanInspectorAssignmentNotFoundError();

    const { active, responseRow } = await assertInspectorResponderOrThrow(
      tx,
      visit,
      actorUserId,
      input.assignmentId,
    );

    const updated = await handymanAssignmentResponseRepository.markAccepted(
      tx,
      responseRow.id,
      actorUserId,
      input.notes ?? null,
    );
    if (!updated) throw handymanAssignmentResponseDuplicateError();

    await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      assignmentResponseId: updated.id,
      assignmentKind: 'INSPECTION_VISIT',
      assignmentId: active.id,
      handymanRequestId: visit.handymanRequestId,
      visitAppointmentId: visit.id,
      eventType: 'ACKNOWLEDGED_TERIMA',
      responseStatus: 'ACCEPTED',
      responseCode: 'TERIMA',
      notes: input.notes ?? null,
      actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    await recordOperationalEvent(
      {
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        eventType: 'HANDYMAN_INSPECTOR_ASSIGNMENT_ACKNOWLEDGED',
        entityType: 'HANDYMAN_INSPECTOR_ASSIGNMENT',
        entityId: active.id,
        actorUserId,
        summary: 'Inspector acknowledged (TERIMA) inspection visit assignment.',
        metadata: {
          assignmentId: active.id,
          visitAppointmentId: visit.id,
          handymanRequestId: visit.handymanRequestId,
          responseStatus: 'ACCEPTED',
          responseCode: 'TERIMA',
          respondedAt: updated.respondedAt!.toISOString(),
        },
      },
      tx,
    );

    const now = await handymanAssignmentResponseRepository.getServerNow(tx);
    return toPublicAssignmentResponse(updated, now, true);
  });
}

export async function declineInspectorVisitAssignment(
  visitAppointmentId: string,
  actorUserId: string,
  input: {
    assignmentId?: string;
    reason: string;
    notes?: string;
    idempotencyKey?: string;
  },
): Promise<PublicAssignmentResponse> {
  return withTransaction(async (tx) => {
    const visit = await handymanInspectorAssignmentRepository.lockVisit(
      tx,
      visitAppointmentId,
    );
    if (!visit) throw handymanInspectorAssignmentNotFoundError();
    if (visit.state === 'IN_PROGRESS' || visit.state === 'COMPLETED') {
      throw handymanAssignmentActiveSessionBlockError();
    }

    const { active, responseRow } = await assertInspectorResponderOrThrow(
      tx,
      visit,
      actorUserId,
      input.assignmentId,
    );

    const updated = await handymanAssignmentResponseRepository.markDeclined(
      tx,
      responseRow.id,
      actorUserId,
      input.reason,
      input.notes ?? null,
    );
    if (!updated) throw handymanAssignmentResponseDuplicateError();

    await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      assignmentResponseId: updated.id,
      assignmentKind: 'INSPECTION_VISIT',
      assignmentId: active.id,
      handymanRequestId: visit.handymanRequestId,
      visitAppointmentId: visit.id,
      eventType: 'DECLINED_TIDAK_BISA',
      responseStatus: 'DECLINED',
      responseCode: 'TIDAK_BISA',
      reason: input.reason,
      notes: input.notes ?? null,
      actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    // Revoke inspector assignment WITHOUT cancelling the Tenant visit or request.
    const revoked = await handymanInspectorAssignmentRepository.supersede(
      tx,
      active.id,
      'REVOKED',
      `TIDAK_BISA: ${input.reason}`.slice(0, 1000),
      active.version,
    );
    if (!revoked) throw handymanAssignmentSupersededError();

    await recordOperationalEvent(
      {
        clientId: visit.clientId,
        buildingId: visit.buildingId,
        eventType: 'HANDYMAN_INSPECTOR_ASSIGNMENT_DECLINED',
        entityType: 'HANDYMAN_INSPECTOR_ASSIGNMENT',
        entityId: active.id,
        actorUserId,
        summary: `Inspector declined (TIDAK_BISA) inspection visit: ${input.reason}`,
        metadata: {
          assignmentId: active.id,
          visitAppointmentId: visit.id,
          handymanRequestId: visit.handymanRequestId,
          responseStatus: 'DECLINED',
          responseCode: 'TIDAK_BISA',
          reason: input.reason,
          respondedAt: updated.respondedAt!.toISOString(),
          requiresReassignment: true,
        },
      },
      tx,
    );

    const opsRecipients =
      await handymanAssignmentResponseRepository.resolveOperationsDeclineRecipients(
        tx,
        {
          clientId: visit.clientId,
          buildingId: visit.buildingId,
          assignedByUserId: active.assignedByUserId,
          excludeUserId: actorUserId,
          permissionCode: 'tenant_company.manage',
        },
      );

    for (const opsUserId of opsRecipients) {
      await handymanAssignmentResponseRepository.emitTargetedInAppNotificationTx(
        tx,
        {
          clientId: visit.clientId,
          buildingId: visit.buildingId,
          recipientUserId: opsUserId,
          type: 'HANDYMAN_INSPECTOR_ASSIGNMENT_DECLINED_OPERATIONS_ACTION_REQUIRED',
          title: 'Inspektor Menolak Penugasan (TIDAK BISA) — Perlu Reassignment',
          body: `Inspektor menyatakan TIDAK BISA untuk jadwal inspeksi. Alasan: ${input.reason.slice(0, 180)}`,
          sourceEntityType: 'HANDYMAN_INSPECTOR_ASSIGNMENT',
          sourceEntityId: active.id,
          sourceEventType: 'HANDYMAN_INSPECTOR_ASSIGNMENT_DECLINED',
          metadata: {
            assignmentKind: 'INSPECTION_VISIT',
            assignmentId: active.id,
            assignmentVersion: revoked.version,
            visitAppointmentId: visit.id,
            handymanRequestId: visit.handymanRequestId,
            buildingId: visit.buildingId,
            declinedByUserId: actorUserId,
            responseStatus: 'DECLINED',
            responseCode: 'TIDAK_BISA',
            reason: input.reason,
            respondedAt: updated.respondedAt!.toISOString(),
            requiresReassignment: true,
          },
          navigationTarget: null,
          enqueuePushIfRegistered: true,
        },
      );
    }

    const now = await handymanAssignmentResponseRepository.getServerNow(tx);
    return toPublicAssignmentResponse(updated, now, false);
  });
}

// ---------------------------------------------------------------------------
// 5. Direct Handyman Worker (`work_orders`) Response: ACKNOWLEDGE reuse + DECLINE
// ---------------------------------------------------------------------------

async function didUserOwnPriorWorkOrderAssignment(
  executor: Pick<PoolClient, 'query'>,
  workOrderId: string,
  activeAssignmentId: string | null,
  actorUserId: string,
): Promise<{ found: boolean; declinedAndUnreplaced: boolean }> {
  const profile = await workforceRepository.findByUserId(actorUserId);
  if (!profile) {
    return { found: false, declinedAndUnreplaced: false };
  }
  const rows = await executor.query<{
    id: string;
    assignee_type: string;
    workforce_profile_id: string | null;
    team_id: string | null;
    vendor_id: string | null;
    response_status: string | null;
    superseded_by_assignment_id: string | null;
  }>(
    `SELECT a.id,
            a.assignee_type,
            a.workforce_profile_id,
            a.team_id,
            a.vendor_id,
            r.response_status,
            r.superseded_by_assignment_id
       FROM work_order_assignments a
       LEFT JOIN handyman_assignment_responses r
         ON r.assignment_id = a.id
      WHERE a.work_order_id = $1
        AND a.status = 'INACTIVE'
        AND ($2::uuid IS NULL OR a.id <> $2)
      ORDER BY a.assigned_at DESC, a.id DESC`,
    [workOrderId, activeAssignmentId],
  );

  for (const row of rows.rows) {
    let matches = false;
    if (
      (row.assignee_type === 'WORKFORCE' ||
        row.assignee_type === 'VENDOR_WORKFORCE') &&
      row.workforce_profile_id === profile.id
    ) {
      matches = true;
    } else if (
      row.assignee_type === 'TEAM' &&
      profile.teamId !== null &&
      row.team_id === profile.teamId
    ) {
      matches = true;
    } else if (row.assignee_type === 'VENDOR' && row.vendor_id !== null) {
      const binding =
        await vendorWorkforceRepository.findActiveByVendorAndWorkforce(
          row.vendor_id,
          profile.id,
        );
      if (binding) matches = true;
    }

    if (matches) {
      const declinedAndUnreplaced =
        row.response_status === 'DECLINED' &&
        activeAssignmentId === null &&
        row.superseded_by_assignment_id === null;
      return { found: true, declinedAndUnreplaced };
    }
  }
  return { found: false, declinedAndUnreplaced: false };
}

/**
 * Checks whether an actor attempting `ACKNOWLEDGE` or `DECLINE` on a Work Order
 * is referencing a superseded assignment (409) or already declined (409).
 */
export async function precheckWorkOrderAssignmentResponseGuard(
  workOrder: WorkOrderRecord,
  activeAssignment: WorkOrderAssignmentRecord | null,
  actorUserId: string,
  requestedAssignmentId?: string,
  isActorCurrentlyAuthorized = false,
): Promise<void> {
  const pool = getPool();

  if (requestedAssignmentId) {
    const target = await workOrderAssignmentRepository.findById(
      requestedAssignmentId,
    );
    if (!target || target.workOrderId !== workOrder.id) {
      throw workOrderExecutionUnauthorizedError();
    }
    if (target.status !== 'ACTIVE') {
      const resp =
        await handymanAssignmentResponseRepository.findByAssignmentId(
          pool,
          requestedAssignmentId,
        );
      if (
        resp &&
        resp.responseStatus === 'DECLINED' &&
        activeAssignment === null &&
        !resp.supersededByAssignmentId
      ) {
        throw handymanAssignmentResponseDuplicateError();
      }
      throw handymanAssignmentSupersededError();
    }
  }

  if (!activeAssignment) {
    const prior = await didUserOwnPriorWorkOrderAssignment(
      pool,
      workOrder.id,
      null,
      actorUserId,
    );
    if (prior.found) {
      if (prior.declinedAndUnreplaced) {
        throw handymanAssignmentResponseDuplicateError();
      }
      throw handymanAssignmentSupersededError();
    }
    throw workOrderExecutionNoAssignmentError();
  }

  if (!isActorCurrentlyAuthorized) {
    const prior = await didUserOwnPriorWorkOrderAssignment(
      pool,
      workOrder.id,
      activeAssignment.id,
      actorUserId,
    );
    if (prior.found) {
      throw handymanAssignmentSupersededError();
    }
    throw workOrderExecutionUnauthorizedError();
  }
}

/**
 * Invoked inside `recordWorkOrderAction` when `actionType === 'ACKNOWLEDGED'`.
 * Reuses `ACKNOWLEDGE` directly as `TERIMA` — zero second acceptance lifecycle!
 */
export async function acknowledgeWorkOrderAssignmentTx(
  tx: PoolClient,
  input: {
    workOrder: WorkOrderRecord;
    assignment: WorkOrderAssignmentRecord;
    actorUserId: string;
    notes: string | null;
  },
): Promise<HandymanAssignmentResponseRecord> {
  let responseRow = await handymanAssignmentResponseRepository.lockByAssignmentId(
    tx,
    input.assignment.id,
  );
  if (!responseRow) {
    // Backward-compatible lazy materialization for raw-SQL test fixtures.
    const { primaryUserId } = await resolveWorkOrderAssignmentRecipientUserIds(
      tx,
      input.assignment,
      input.workOrder.buildingId,
    );
    const policy =
      await handymanAssignmentResponseRepository.resolveEffectiveDeadlinePolicy(
        tx,
        input.workOrder.clientId,
        input.workOrder.buildingId,
      );
    responseRow =
      await handymanAssignmentResponseRepository.insertPendingResponse(tx, {
        clientId: input.workOrder.clientId,
        buildingId: input.workOrder.buildingId,
        assignmentKind: 'WORK_ORDER',
        assignmentId: input.assignment.id,
        workOrderId: input.workOrder.id,
        expectedResponderUserId: primaryUserId,
        assignedByUserId: input.assignment.assignedByUserId,
        assignedAt: input.assignment.assignedAt,
        deadlineMinutes: policy.deadlineMinutes,
      });
  }

  if (responseRow.responseStatus !== 'PENDING') {
    if (responseRow.responseStatus === 'SUPERSEDED') {
      throw handymanAssignmentSupersededError();
    }
    throw handymanAssignmentResponseDuplicateError();
  }

  const now = await handymanAssignmentResponseRepository.getServerNow(tx);
  if (now.getTime() > responseRow.responseDeadlineAt.getTime()) {
    throw handymanAssignmentResponseExpiredError(
      responseRow.responseDeadlineAt.toISOString(),
    );
  }

  const updated = await handymanAssignmentResponseRepository.markAccepted(
    tx,
    responseRow.id,
    input.actorUserId,
    input.notes,
  );
  if (!updated) throw handymanAssignmentResponseDuplicateError();

  await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
    clientId: input.workOrder.clientId,
    buildingId: input.workOrder.buildingId,
    assignmentResponseId: updated.id,
    assignmentKind: 'WORK_ORDER',
    assignmentId: input.assignment.id,
    workOrderId: input.workOrder.id,
    eventType: 'ACKNOWLEDGED_TERIMA',
    responseStatus: 'ACCEPTED',
    responseCode: 'TERIMA',
    notes: input.notes,
    actorUserId: input.actorUserId,
  });

  return updated;
}

/**
 * `POST /work-orders/:id/decline` — `TIDAK_BISA` response for direct Handyman
 * workforce (permanent, contract, outsourced, freelance, vendor workforce).
 *
 * Never cancels the Tenant's Work Order (`work_orders.status` returns to `OPEN`,
 * NEVER `CANCELLED`); deactivates only the declining worker's assignment and
 * notifies Operations for reassignment.
 */
export async function declineWorkOrderAssignment(
  workOrderId: string,
  actorUserId: string,
  input: {
    assignmentId?: string;
    reason: string;
    notes?: string;
    idempotencyKey?: string;
  },
  isAuthorizedFn: (
    userId: string,
    assignment: WorkOrderAssignmentRecord,
  ) => Promise<boolean>,
): Promise<PublicAssignmentResponse> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) throw workOrderNotFoundError();

  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
  });

  const activeAssignment =
    await workOrderAssignmentRepository.findActiveByWorkOrderId(workOrderId);
  const authorized = activeAssignment
    ? await isAuthorizedFn(actorUserId, activeAssignment)
    : false;

  await precheckWorkOrderAssignmentResponseGuard(
    workOrder,
    activeAssignment,
    actorUserId,
    input.assignmentId,
    authorized,
  );

  // Cannot decline once work execution has started or closed.
  if (workOrder.status !== 'OPEN' && workOrder.status !== 'ASSIGNED') {
    throw workOrderExecutionInvalidStateError();
  }

  const assignment = activeAssignment!;

  const result = await withTransaction(async (tx) => {
    // Re-lock active assignment inside tx to prevent concurrent races.
    const locked = await tx.query<{ status: string }>(
      `SELECT status FROM work_order_assignments WHERE id = $1 FOR UPDATE`,
      [assignment.id],
    );
    if (!locked.rows[0] || locked.rows[0].status !== 'ACTIVE') {
      throw handymanAssignmentSupersededError();
    }

    let responseRow =
      await handymanAssignmentResponseRepository.lockByAssignmentId(
        tx,
        assignment.id,
      );
    if (!responseRow) {
      const { primaryUserId } =
        await resolveWorkOrderAssignmentRecipientUserIds(
          tx,
          assignment,
          workOrder.buildingId,
        );
      const policy =
        await handymanAssignmentResponseRepository.resolveEffectiveDeadlinePolicy(
          tx,
          workOrder.clientId,
          workOrder.buildingId,
        );
      responseRow =
        await handymanAssignmentResponseRepository.insertPendingResponse(tx, {
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          assignmentKind: 'WORK_ORDER',
          assignmentId: assignment.id,
          workOrderId: workOrder.id,
          expectedResponderUserId: primaryUserId,
          assignedByUserId: assignment.assignedByUserId,
          assignedAt: assignment.assignedAt,
          deadlineMinutes: policy.deadlineMinutes,
        });
    }

    if (responseRow.responseStatus !== 'PENDING') {
      if (responseRow.responseStatus === 'SUPERSEDED') {
        throw handymanAssignmentSupersededError();
      }
      throw handymanAssignmentResponseDuplicateError();
    }

    const now = await handymanAssignmentResponseRepository.getServerNow(tx);
    if (now.getTime() > responseRow.responseDeadlineAt.getTime()) {
      throw handymanAssignmentResponseExpiredError(
        responseRow.responseDeadlineAt.toISOString(),
      );
    }

    const updated = await handymanAssignmentResponseRepository.markDeclined(
      tx,
      responseRow.id,
      actorUserId,
      input.reason,
      input.notes ?? null,
    );
    if (!updated) throw handymanAssignmentResponseDuplicateError();

    await handymanAssignmentResponseRepository.appendResponseEvent(tx, {
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      assignmentResponseId: updated.id,
      assignmentKind: 'WORK_ORDER',
      assignmentId: assignment.id,
      workOrderId: workOrder.id,
      eventType: 'DECLINED_TIDAK_BISA',
      responseStatus: 'DECLINED',
      responseCode: 'TIDAK_BISA',
      reason: input.reason,
      notes: input.notes ?? null,
      actorUserId,
      idempotencyKey: input.idempotencyKey ?? null,
    });

    // Deactivate the declined assignment row (revoking worker's authority)
    // and ensure Work Order remains OPEN (NEVER CANCELLED) awaiting reassignment.
    await tx.query(
      `UPDATE work_order_assignments
          SET status = 'INACTIVE', updated_at = NOW()
        WHERE id = $1`,
      [assignment.id],
    );
    if (workOrder.status === 'ASSIGNED') {
      await workOrderRepository.updateStatus(workOrder.id, 'OPEN', tx);
    }

    await recordOperationalEvent(
      {
        clientId: workOrder.clientId,
        buildingId: workOrder.buildingId,
        eventType: 'WORK_ORDER_ASSIGNMENT_DECLINED',
        entityType: 'WORK_ORDER',
        entityId: workOrder.id,
        actorUserId,
        summary: `Assigned worker declined (TIDAK_BISA) Work Order ${workOrder.workOrderNumber}: ${input.reason}`,
        metadata: {
          workOrderId: workOrder.id,
          assignmentId: assignment.id,
          responseStatus: 'DECLINED',
          responseCode: 'TIDAK_BISA',
          reason: input.reason,
          respondedAt: updated.respondedAt!.toISOString(),
          requiresReassignment: true,
          tenantWorkOrderCancelled: false,
        },
      },
      tx,
    );

    const opsRecipients =
      await handymanAssignmentResponseRepository.resolveOperationsDeclineRecipients(
        tx,
        {
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          assignedByUserId: assignment.assignedByUserId,
          excludeUserId: actorUserId,
          permissionCode: 'work_order.manage',
        },
      );

    for (const opsUserId of opsRecipients) {
      await handymanAssignmentResponseRepository.emitTargetedInAppNotificationTx(
        tx,
        {
          clientId: workOrder.clientId,
          buildingId: workOrder.buildingId,
          recipientUserId: opsUserId,
          type: 'WORK_ORDER_ASSIGNMENT_DECLINED_OPERATIONS_ACTION_REQUIRED',
          title: `Petugas Menolak Work Order ${workOrder.workOrderNumber} (TIDAK BISA)`,
          body: `Petugas menyatakan TIDAK BISA untuk Work Order "${workOrder.title.slice(0, 120)}". Alasan: ${input.reason.slice(0, 160)}`,
          sourceEntityType: 'WORK_ORDER_ASSIGNMENT',
          sourceEntityId: assignment.id,
          sourceEventType: 'WORK_ORDER_ASSIGNMENT_DECLINED',
          metadata: {
            assignmentKind: 'WORK_ORDER',
            assignmentId: assignment.id,
            workOrderId: workOrder.id,
            workOrderNumber: workOrder.workOrderNumber,
            buildingId: workOrder.buildingId,
            declinedByUserId: actorUserId,
            responseStatus: 'DECLINED',
            responseCode: 'TIDAK_BISA',
            reason: input.reason,
            respondedAt: updated.respondedAt!.toISOString(),
            requiresReassignment: true,
          },
          navigationTarget: null,
          enqueuePushIfRegistered: true,
        },
      );
    }

    return { updated, now };
  });

  await recordWorkOrderEvent({
    workOrderId: workOrder.id,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    eventType: 'WORK_ORDER_ASSIGNMENT_DECLINED',
    actorUserId,
    summary: `Assigned worker declined (TIDAK_BISA): ${input.reason}`,
    metadata: {
      assignmentId: assignment.id,
      responseStatus: 'DECLINED',
      responseCode: 'TIDAK_BISA',
      reason: input.reason,
      requiresReassignment: true,
    },
  });

  return toPublicAssignmentResponse(result.updated, result.now, false);
}

// ---------------------------------------------------------------------------
// 6. Operations Read Projections (PENDING / ACCEPTED / DECLINED + reason + history)
// ---------------------------------------------------------------------------

function buildOperationsVisibility(params: {
  targetKind: 'EXECUTION_SCOPE_CREW' | 'INSPECTION_VISIT' | 'WORK_ORDER';
  clientId: string;
  buildingId: string;
  executionScopeId?: string | null;
  handymanRequestId?: string | null;
  visitAppointmentId?: string | null;
  workOrderId?: string | null;
  targetLifecycleStatus: string;
  activeAssignmentId: string | null;
  responses: HandymanAssignmentResponseRecord[];
  events: HandymanAssignmentResponseEventRecord[];
  now: Date;
}): OperationsAssignmentResponseVisibility {
  const mappedResponses = params.responses.map((r) =>
    toPublicAssignmentResponse(
      r,
      params.now,
      params.activeAssignmentId !== null && r.assignmentId === params.activeAssignmentId,
    ),
  );
  const currentResponse = params.activeAssignmentId
    ? mappedResponses.find((r) => r.assignmentId === params.activeAssignmentId) ??
      null
    : null;
  const latestResponse = mappedResponses[0] ?? null;

  let requiresReassignment = false;
  let reassignmentReasonCode: OperationsAssignmentResponseVisibility['reassignmentReasonCode'] =
    null;

  if (!params.activeAssignmentId) {
    if (latestResponse?.responseStatus === 'DECLINED') {
      requiresReassignment = true;
      reassignmentReasonCode = 'WORKER_DECLINED_TIDAK_BISA';
    } else if (
      params.targetLifecycleStatus !== 'CANCELLED' &&
      params.targetLifecycleStatus !== 'COMPLETED' &&
      params.targetLifecycleStatus !== 'CLOSED'
    ) {
      requiresReassignment = true;
      reassignmentReasonCode = 'UNASSIGNED';
    }
  } else if (currentResponse?.isResponseOverdue) {
    requiresReassignment = true;
    reassignmentReasonCode = 'RESPONSE_DEADLINE_EXCEEDED';
  }

  return {
    targetKind: params.targetKind,
    clientId: params.clientId,
    buildingId: params.buildingId,
    executionScopeId: params.executionScopeId ?? null,
    handymanRequestId: params.handymanRequestId ?? null,
    visitAppointmentId: params.visitAppointmentId ?? null,
    workOrderId: params.workOrderId ?? null,
    targetLifecycleStatus: params.targetLifecycleStatus,
    tenantWorkOrderCancelled: false,
    requiresReassignment,
    reassignmentReasonCode,
    currentResponse,
    latestResponse,
    responses: mappedResponses,
    history: params.events.map(toPublicAssignmentResponseEvent),
  };
}

export async function getOperationsExecutionScopeResponseVisibility(
  executionScopeId: string,
  actorUserId: string,
): Promise<OperationsAssignmentResponseVisibility> {
  const pool = getPool();
  const scopeRes = await pool.query<{
    id: string;
    client_id: string;
    building_id: string;
    handyman_request_id: string;
    status: string;
  }>(
    `SELECT id, client_id, building_id, handyman_request_id, status
       FROM handyman_execution_scopes
      WHERE id = $1`,
    [executionScopeId],
  );
  const scope = scopeRes.rows[0];
  if (!scope) throw handymanExecutionScopeNotFoundError();

  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: scope.client_id,
    buildingId: scope.building_id,
  });

  const [active, responses, events, now] = await Promise.all([
    handymanScopeAssignmentRepository.findActiveAssignmentByScope(
      pool,
      scope.id,
    ),
    handymanAssignmentResponseRepository.listResponsesByScope(
      pool,
      scope.client_id,
      scope.id,
    ),
    handymanAssignmentResponseRepository.listEventsByScope(
      pool,
      scope.client_id,
      scope.id,
    ),
    handymanAssignmentResponseRepository.getServerNow(pool),
  ]);

  return buildOperationsVisibility({
    targetKind: 'EXECUTION_SCOPE_CREW',
    clientId: scope.client_id,
    buildingId: scope.building_id,
    executionScopeId: scope.id,
    handymanRequestId: scope.handyman_request_id,
    targetLifecycleStatus: scope.status,
    activeAssignmentId: active?.id ?? null,
    responses,
    events,
    now,
  });
}

export async function getOperationsInspectorVisitResponseVisibility(
  visitAppointmentId: string,
  actorUserId: string,
): Promise<OperationsAssignmentResponseVisibility> {
  const pool = getPool();
  const visit = await handymanInspectorAssignmentRepository.findVisit(
    pool,
    visitAppointmentId,
  );
  if (!visit) throw handymanInspectorAssignmentNotFoundError();

  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: visit.clientId,
    buildingId: visit.buildingId,
  });

  const [active, responses, events, now] = await Promise.all([
    handymanInspectorAssignmentRepository.findActiveByVisit(pool, visit.id),
    handymanAssignmentResponseRepository.listResponsesByVisit(
      pool,
      visit.clientId,
      visit.id,
    ),
    handymanAssignmentResponseRepository.listEventsByVisit(
      pool,
      visit.clientId,
      visit.id,
    ),
    handymanAssignmentResponseRepository.getServerNow(pool),
  ]);

  return buildOperationsVisibility({
    targetKind: 'INSPECTION_VISIT',
    clientId: visit.clientId,
    buildingId: visit.buildingId,
    handymanRequestId: visit.handymanRequestId,
    visitAppointmentId: visit.id,
    targetLifecycleStatus: visit.state,
    activeAssignmentId: active?.id ?? null,
    responses,
    events,
    now,
  });
}

export async function getOperationsWorkOrderResponseVisibility(
  workOrderId: string,
  actorUserId: string,
): Promise<OperationsAssignmentResponseVisibility> {
  const pool = getPool();
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) throw workOrderNotFoundError();

  await assertBuildingScopedResourceAccess(actorUserId, {
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
  });

  const [active, responses, events, now] = await Promise.all([
    workOrderAssignmentRepository.findActiveByWorkOrderId(workOrder.id),
    handymanAssignmentResponseRepository.listResponsesByWorkOrder(
      pool,
      workOrder.clientId,
      workOrder.id,
    ),
    handymanAssignmentResponseRepository.listEventsByWorkOrder(
      pool,
      workOrder.clientId,
      workOrder.id,
    ),
    handymanAssignmentResponseRepository.getServerNow(pool),
  ]);

  return buildOperationsVisibility({
    targetKind: 'WORK_ORDER',
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    workOrderId: workOrder.id,
    targetLifecycleStatus: workOrder.status,
    activeAssignmentId: active?.id ?? null,
    responses,
    events,
    now,
  });
}

export const handymanAssignmentResponseService = {
  getAssignmentDeadlinePolicy,
  configureAssignmentDeadlinePolicy,
  issueExecutionScopeAssignmentResponseTx,
  issueInspectorAssignmentResponseTx,
  supersedeAssignmentResponseOnlyTx,
  issueWorkOrderAssignmentResponse,
  acknowledgeExecutionScopeAssignment,
  declineExecutionScopeAssignment,
  acknowledgeInspectorVisitAssignment,
  declineInspectorVisitAssignment,
  precheckWorkOrderAssignmentResponseGuard,
  acknowledgeWorkOrderAssignmentTx,
  declineWorkOrderAssignment,
  getOperationsExecutionScopeResponseVisibility,
  getOperationsInspectorVisitResponseVisibility,
  getOperationsWorkOrderResponseVisibility,
  toPublicAssignmentResponse,
};

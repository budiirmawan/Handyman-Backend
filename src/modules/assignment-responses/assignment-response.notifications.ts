import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { PublicNotificationNavigationTarget } from '../notifications/notification.types';
import type { WorkOrderAssignmentRecord } from '../work-order-assignments/work-order-assignment.types';
import type { WorkOrderRecord } from '../work-orders/work-order.types';
import type { HandymanAssignmentTargetType } from './assignment-response.types';

export type AssignmentNotificationInput = {
  clientId: string;
  recipientUserId: string;
  type: string;
  title: string;
  body: string;
  sourceEntityType: HandymanAssignmentTargetType;
  sourceEntityId: string;
  sourceEventType: string;
  metadata: Record<string, unknown>;
  navigationTarget?: PublicNotificationNavigationTarget | null;
};

/**
 * Inserts an `IN_APP` notification on the caller's transactional executor,
 * deduplicated on `(recipient_user_id, source_entity_type, source_entity_id, source_event_type)`
 * via `notifications_assignment_response_dedup_idx` (migration 0472).
 *
 * Because this runs inside the same database transaction as the assignment or
 * response mutation, any transaction rollback automatically rolls back the
 * notification row — eliminating phantom notifications.
 */
export async function recordDeduplicatedAssignmentNotification(
  input: AssignmentNotificationInput,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<string | null> {
  const result = await executor.query<{ id: string }>(
    `INSERT INTO notifications (
       id, client_id, recipient_user_id, type, channel, status, title, body,
       source_entity_type, source_entity_id, source_event_type, template_key,
       metadata, navigation_target_type, navigation_target_id
     )
     VALUES ($1, $2, $3, $4, 'IN_APP', 'UNREAD', $5, $6, $7, $8, $9, NULL, $10, $11, $12)
     ON CONFLICT (recipient_user_id, source_entity_type, source_entity_id, source_event_type)
       WHERE source_entity_type IN (
         'WORK_ORDER_ASSIGNMENT',
         'EXECUTION_SCOPE_ASSIGNMENT',
         'INSPECTOR_VISIT_ASSIGNMENT'
       )
       AND source_event_type IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.clientId,
      input.recipientUserId,
      input.type,
      input.title,
      input.body,
      input.sourceEntityType,
      input.sourceEntityId,
      input.sourceEventType,
      input.metadata,
      input.navigationTarget?.type ?? null,
      input.navigationTarget?.id ?? null,
    ],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Resolves the active recipient user IDs for a Standard Work Order assignment:
 *   - `WORKFORCE`: the assigned active Workforce Profile's linked active User.
 *   - `VENDOR_WORKFORCE`: the assigned active Vendor Workforce Profile's linked active User.
 *   - `TEAM`: all active Workforce Profiles in the assigned Team with linked active Users.
 *   - `VENDOR`: all active Vendor Workforce bindings for the Vendor with active Workforce Profiles and linked active Users.
 */
export async function resolveWorkOrderAssignmentRecipientUserIds(
  assignment: Pick<
    WorkOrderAssignmentRecord,
    'assigneeType' | 'workforceProfileId' | 'teamId' | 'vendorId'
  >,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<string[]> {
  switch (assignment.assigneeType) {
    case 'WORKFORCE': {
      if (!assignment.workforceProfileId) return [];
      const result = await executor.query<{ user_id: string }>(
        `SELECT wp.user_id
           FROM workforce_profiles wp
           JOIN users u ON u.id = wp.user_id
          WHERE wp.id = $1
            AND wp.status = 'ACTIVE'
            AND wp.user_id IS NOT NULL
            AND u.status = 'ACTIVE'`,
        [assignment.workforceProfileId],
      );
      return result.rows.map((r) => r.user_id);
    }

    case 'VENDOR_WORKFORCE': {
      if (!assignment.workforceProfileId || !assignment.vendorId) return [];
      const result = await executor.query<{ user_id: string }>(
        `SELECT DISTINCT wp.user_id
           FROM workforce_profiles wp
           JOIN vendor_workforce_bindings vwb
             ON vwb.workforce_profile_id = wp.id
            AND vwb.vendor_id = $2
            AND vwb.status = 'ACTIVE'
           JOIN users u ON u.id = wp.user_id
          WHERE wp.id = $1
            AND wp.status = 'ACTIVE'
            AND wp.user_id IS NOT NULL
            AND u.status = 'ACTIVE'`,
        [assignment.workforceProfileId, assignment.vendorId],
      );
      return result.rows.map((r) => r.user_id);
    }

    case 'TEAM': {
      if (!assignment.teamId) return [];
      const result = await executor.query<{ user_id: string }>(
        `SELECT DISTINCT wp.user_id
           FROM workforce_profiles wp
           JOIN teams t ON t.id = wp.team_id
           JOIN users u ON u.id = wp.user_id
          WHERE wp.team_id = $1
            AND t.status = 'ACTIVE'
            AND wp.status = 'ACTIVE'
            AND wp.user_id IS NOT NULL
            AND u.status = 'ACTIVE'
          ORDER BY wp.user_id ASC`,
        [assignment.teamId],
      );
      return result.rows.map((r) => r.user_id);
    }

    case 'VENDOR': {
      if (!assignment.vendorId) return [];
      const result = await executor.query<{ user_id: string }>(
        `SELECT DISTINCT wp.user_id
           FROM vendor_workforce_bindings vwb
           JOIN vendors v ON v.id = vwb.vendor_id
           JOIN workforce_profiles wp ON wp.id = vwb.workforce_profile_id
           JOIN users u ON u.id = wp.user_id
          WHERE vwb.vendor_id = $1
            AND vwb.status = 'ACTIVE'
            AND v.status = 'ACTIVE'
            AND wp.status = 'ACTIVE'
            AND wp.user_id IS NOT NULL
            AND u.status = 'ACTIVE'
          ORDER BY wp.user_id ASC`,
        [assignment.vendorId],
      );
      return result.rows.map((r) => r.user_id);
    }
  }
}

export async function resolveWorkOrderOperationsRecipientUserIds(
  workOrder: Pick<WorkOrderRecord, 'createdByUserId'>,
  assignment: Pick<WorkOrderAssignmentRecord, 'assignedByUserId'>,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<string[]> {
  const candidates = Array.from(
    new Set(
      [assignment.assignedByUserId, workOrder.createdByUserId].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  );
  if (candidates.length === 0) return [];

  const result = await executor.query<{ id: string }>(
    `SELECT id
       FROM users
      WHERE id = ANY($1::uuid[])
        AND status = 'ACTIVE'
      ORDER BY id ASC`,
    [candidates],
  );
  return result.rows.map((r) => r.id);
}

export async function notifyWorkOrderAssignedPending(
  workOrder: Pick<
    WorkOrderRecord,
    'id' | 'clientId' | 'buildingId' | 'workOrderNumber' | 'title'
  >,
  assignment: WorkOrderAssignmentRecord,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const recipients = await resolveWorkOrderAssignmentRecipientUserIds(
    assignment,
    executor,
  );
  for (const recipientUserId of recipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: workOrder.clientId,
        recipientUserId,
        type: 'WORK_ORDER_ASSIGNMENT_PENDING',
        title: `Penugasan Work Order ${workOrder.workOrderNumber}`,
        body: `Anda menerima penugasan baru untuk Work Order ${workOrder.workOrderNumber} (${workOrder.title}). Silakan konfirmasi TERIMA atau TIDAK_BISA.`,
        sourceEntityType: 'WORK_ORDER_ASSIGNMENT',
        sourceEntityId: assignment.id,
        sourceEventType: 'WORK_ORDER_ASSIGNMENT_PENDING',
        navigationTarget: {
          type: 'WORK_ORDER_FIELD_WORK',
          id: workOrder.id,
        },
        metadata: {
          workOrderId: workOrder.id,
          workOrderNumber: workOrder.workOrderNumber,
          buildingId: workOrder.buildingId,
          assignmentId: assignment.id,
          assigneeType: assignment.assigneeType,
          responseStatus: 'PENDING',
        },
      },
      executor,
    );
  }
}

export async function notifyWorkOrderAssignmentSuperseded(
  workOrder: Pick<
    WorkOrderRecord,
    'id' | 'clientId' | 'buildingId' | 'workOrderNumber' | 'title'
  >,
  oldAssignment: WorkOrderAssignmentRecord,
  newAssignment: WorkOrderAssignmentRecord,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const [oldRecipients, newRecipients] = await Promise.all([
    resolveWorkOrderAssignmentRecipientUserIds(oldAssignment, executor),
    resolveWorkOrderAssignmentRecipientUserIds(newAssignment, executor),
  ]);
  const newSet = new Set(newRecipients);

  for (const recipientUserId of oldRecipients) {
    if (newSet.has(recipientUserId)) continue;
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: workOrder.clientId,
        recipientUserId,
        type: 'WORK_ORDER_ASSIGNMENT_SUPERSEDED',
        title: `Penugasan Work Order ${workOrder.workOrderNumber} Digantikan`,
        body: `Penugasan Anda pada Work Order ${workOrder.workOrderNumber} (${workOrder.title}) telah digantikan oleh penugasan baru.`,
        sourceEntityType: 'WORK_ORDER_ASSIGNMENT',
        sourceEntityId: oldAssignment.id,
        sourceEventType: 'WORK_ORDER_ASSIGNMENT_SUPERSEDED',
        navigationTarget: null,
        metadata: {
          workOrderId: workOrder.id,
          workOrderNumber: workOrder.workOrderNumber,
          buildingId: workOrder.buildingId,
          supersededAssignmentId: oldAssignment.id,
          replacementAssignmentId: newAssignment.id,
        },
      },
      executor,
    );
  }
}

export async function notifyWorkOrderAssignmentAccepted(
  workOrder: Pick<
    WorkOrderRecord,
    | 'id'
    | 'clientId'
    | 'buildingId'
    | 'workOrderNumber'
    | 'title'
    | 'createdByUserId'
  >,
  assignment: WorkOrderAssignmentRecord,
  respondedByUserId: string,
  respondedAt: Date,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const operationsRecipients = await resolveWorkOrderOperationsRecipientUserIds(
    workOrder,
    assignment,
    executor,
  );
  for (const recipientUserId of operationsRecipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: workOrder.clientId,
        recipientUserId,
        type: 'WORK_ORDER_ASSIGNMENT_ACCEPTED',
        title: `Penugasan Work Order ${workOrder.workOrderNumber} Diterima`,
        body: `Penugasan pada Work Order ${workOrder.workOrderNumber} (${workOrder.title}) telah dikonfirmasi TERIMA oleh petugas.`,
        sourceEntityType: 'WORK_ORDER_ASSIGNMENT',
        sourceEntityId: assignment.id,
        sourceEventType: 'WORK_ORDER_ASSIGNMENT_ACCEPTED',
        navigationTarget: {
          type: 'WORK_ORDER_FIELD_WORK',
          id: workOrder.id,
        },
        metadata: {
          workOrderId: workOrder.id,
          workOrderNumber: workOrder.workOrderNumber,
          buildingId: workOrder.buildingId,
          assignmentId: assignment.id,
          responseStatus: 'TERIMA',
          respondedByUserId,
          respondedAt: respondedAt.toISOString(),
          reassignmentRequired: false,
        },
      },
      executor,
    );
  }
}

export async function notifyWorkOrderAssignmentDeclined(
  workOrder: Pick<
    WorkOrderRecord,
    | 'id'
    | 'clientId'
    | 'buildingId'
    | 'workOrderNumber'
    | 'title'
    | 'createdByUserId'
  >,
  assignment: WorkOrderAssignmentRecord,
  respondedByUserId: string,
  respondedAt: Date,
  declineReason: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const operationsRecipients = await resolveWorkOrderOperationsRecipientUserIds(
    workOrder,
    assignment,
    executor,
  );
  for (const recipientUserId of operationsRecipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: workOrder.clientId,
        recipientUserId,
        type: 'WORK_ORDER_ASSIGNMENT_DECLINED',
        title: `Penugasan Work Order ${workOrder.workOrderNumber} Ditolak (TIDAK_BISA)`,
        body: `Petugas menolak penugasan Work Order ${workOrder.workOrderNumber} (${workOrder.title}) dengan alasan: ${declineReason}. Penugasan ulang diperlukan.`,
        sourceEntityType: 'WORK_ORDER_ASSIGNMENT',
        sourceEntityId: assignment.id,
        sourceEventType: 'WORK_ORDER_ASSIGNMENT_DECLINED',
        navigationTarget: {
          type: 'WORK_ORDER_FIELD_WORK',
          id: workOrder.id,
        },
        metadata: {
          workOrderId: workOrder.id,
          workOrderNumber: workOrder.workOrderNumber,
          buildingId: workOrder.buildingId,
          assignmentId: assignment.id,
          responseStatus: 'TIDAK_BISA',
          respondedByUserId,
          respondedAt: respondedAt.toISOString(),
          declineReason,
          reassignmentRequired: true,
        },
      },
      executor,
    );
  }
}

async function filterActiveUserIds(
  candidateIds: Array<string | null | undefined>,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<string[]> {
  const unique = Array.from(
    new Set(
      candidateIds.filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      ),
    ),
  );
  if (unique.length === 0) return [];
  const result = await executor.query<{ id: string }>(
    `SELECT id
       FROM users
      WHERE id = ANY($1::uuid[])
        AND status = 'ACTIVE'
      ORDER BY id ASC`,
    [unique],
  );
  return result.rows.map((r) => r.id);
}

/**
 * Sends an `IN_APP` notification ONLY to the active authorized Crew Lead
 * (`leadUserId`) of an Execution Scope Crew assignment. Helpers (including
 * login-less Helpers without smartphones) are deliberately never notified here;
 * their attendance is governed by `handyman-helper-attendance` (0471).
 */
export async function notifyExecutionScopeCrewLeadAssignedPending(
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    executionScopeId: string;
    assignmentId: string;
    crewId: string;
    leadUserId: string;
    leadWorkerContextId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const recipients = await filterActiveUserIds([input.leadUserId], executor);
  for (const recipientUserId of recipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: input.clientId,
        recipientUserId,
        type: 'EXECUTION_SCOPE_ASSIGNMENT_PENDING',
        title: 'Penugasan Crew Lead Handyman Baru',
        body: 'Anda ditugaskan sebagai Crew Lead (PIC Pekerjaan) pada Execution Scope Handyman. Silakan konfirmasi TERIMA atau TIDAK_BISA.',
    sourceEntityType: 'EXECUTION_SCOPE_ASSIGNMENT',
    sourceEntityId: input.assignmentId,
    sourceEventType: 'EXECUTION_SCOPE_ASSIGNMENT_PENDING',
    navigationTarget: {
      type: 'EXECUTION_SCOPE_FIELD_WORK',
      id: input.executionScopeId,
    },
    metadata: {
          handymanRequestId: input.handymanRequestId,
          executionScopeId: input.executionScopeId,
          buildingId: input.buildingId,
          assignmentId: input.assignmentId,
          crewId: input.crewId,
          leadUserId: input.leadUserId,
          leadWorkerContextId: input.leadWorkerContextId,
          responseStatus: 'PENDING',
        },
      },
      executor,
    );
  }
}

export async function notifyExecutionScopeCrewLeadSuperseded(
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    executionScopeId: string;
    oldAssignmentId: string;
    newAssignmentId: string;
    oldLeadUserId: string | null;
    newLeadUserId: string | null;
    reason: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  if (!input.oldLeadUserId || input.oldLeadUserId === input.newLeadUserId) {
    return;
  }
  const recipients = await filterActiveUserIds([input.oldLeadUserId], executor);
  for (const recipientUserId of recipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: input.clientId,
        recipientUserId,
        type: 'EXECUTION_SCOPE_ASSIGNMENT_SUPERSEDED',
        title: 'Penugasan Crew Lead Handyman Digantikan',
        body: `Penugasan Crew Lead Anda pada Execution Scope telah digantikan (${input.reason}).`,
        sourceEntityType: 'EXECUTION_SCOPE_ASSIGNMENT',
        sourceEntityId: input.oldAssignmentId,
        sourceEventType: 'EXECUTION_SCOPE_ASSIGNMENT_SUPERSEDED',
        navigationTarget: null,
        metadata: {
          handymanRequestId: input.handymanRequestId,
          executionScopeId: input.executionScopeId,
          buildingId: input.buildingId,
          supersededAssignmentId: input.oldAssignmentId,
          replacementAssignmentId: input.newAssignmentId,
          reason: input.reason,
        },
      },
      executor,
    );
  }
}

export async function notifyExecutionScopeAssignmentAccepted(
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    executionScopeId: string;
    assignmentId: string;
    crewId: string;
    assignedByUserId: string;
    respondedByUserId: string;
    respondedByWorkerId: string | null;
    respondedAt: Date;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const recipients = await filterActiveUserIds(
    [input.assignedByUserId],
    executor,
  );
  for (const recipientUserId of recipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: input.clientId,
        recipientUserId,
        type: 'EXECUTION_SCOPE_ASSIGNMENT_ACCEPTED',
        title: 'Penugasan Crew Lead Handyman Diterima (TERIMA)',
        body: 'Crew Lead telah mengonfirmasi TERIMA atas penugasan Execution Scope Handyman.',
        sourceEntityType: 'EXECUTION_SCOPE_ASSIGNMENT',
        sourceEntityId: input.assignmentId,
        sourceEventType: 'EXECUTION_SCOPE_ASSIGNMENT_ACCEPTED',
        navigationTarget: {
          type: 'EXECUTION_SCOPE_FIELD_WORK',
          id: input.executionScopeId,
        },
        metadata: {
          handymanRequestId: input.handymanRequestId,
          executionScopeId: input.executionScopeId,
          buildingId: input.buildingId,
          assignmentId: input.assignmentId,
          crewId: input.crewId,
          responseStatus: 'TERIMA',
          respondedByUserId: input.respondedByUserId,
          respondedByWorkerId: input.respondedByWorkerId,
          respondedAt: input.respondedAt.toISOString(),
          reassignmentRequired: false,
        },
      },
      executor,
    );
  }
}

export async function notifyExecutionScopeAssignmentDeclined(
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    executionScopeId: string;
    assignmentId: string;
    crewId: string;
    assignedByUserId: string;
    respondedByUserId: string;
    respondedByWorkerId: string | null;
    respondedAt: Date;
    declineReason: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const recipients = await filterActiveUserIds(
    [input.assignedByUserId],
    executor,
  );
  for (const recipientUserId of recipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: input.clientId,
        recipientUserId,
        type: 'EXECUTION_SCOPE_ASSIGNMENT_DECLINED',
        title: 'Penugasan Crew Lead Handyman Ditolak (TIDAK_BISA)',
        body: `Crew Lead menolak penugasan Execution Scope dengan alasan: ${input.declineReason}. Penugasan ulang diperlukan.`,
        sourceEntityType: 'EXECUTION_SCOPE_ASSIGNMENT',
        sourceEntityId: input.assignmentId,
        sourceEventType: 'EXECUTION_SCOPE_ASSIGNMENT_DECLINED',
        navigationTarget: {
          type: 'EXECUTION_SCOPE_FIELD_WORK',
          id: input.executionScopeId,
        },
        metadata: {
          handymanRequestId: input.handymanRequestId,
          executionScopeId: input.executionScopeId,
          buildingId: input.buildingId,
          assignmentId: input.assignmentId,
          crewId: input.crewId,
          responseStatus: 'TIDAK_BISA',
          respondedByUserId: input.respondedByUserId,
          respondedByWorkerId: input.respondedByWorkerId,
          respondedAt: input.respondedAt.toISOString(),
          declineReason: input.declineReason,
          reassignmentRequired: true,
        },
      },
      executor,
    );
  }
}

export async function notifyInspectorAssignedPending(
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    visitAppointmentId: string;
    assignmentId: string;
    inspectorUserId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const recipients = await filterActiveUserIds(
    [input.inspectorUserId],
    executor,
  );
  for (const recipientUserId of recipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: input.clientId,
        recipientUserId,
        type: 'INSPECTOR_VISIT_ASSIGNMENT_PENDING',
        title: 'Penugasan Kunjungan Inspeksi Handyman Baru',
        body: 'Anda ditugaskan sebagai Inspector untuk kunjungan inspeksi Handyman. Silakan konfirmasi TERIMA atau TIDAK_BISA.',
        sourceEntityType: 'INSPECTOR_VISIT_ASSIGNMENT',
        sourceEntityId: input.assignmentId,
        sourceEventType: 'INSPECTOR_VISIT_ASSIGNMENT_PENDING',
        navigationTarget: {
          type: 'INSPECTOR_VISIT_FIELD_WORK',
          id: input.visitAppointmentId,
        },
        metadata: {
          handymanRequestId: input.handymanRequestId,
          visitAppointmentId: input.visitAppointmentId,
          buildingId: input.buildingId,
          assignmentId: input.assignmentId,
          inspectorUserId: input.inspectorUserId,
          responseStatus: 'PENDING',
        },
      },
      executor,
    );
  }
}

export async function notifyInspectorAssignmentSuperseded(
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    visitAppointmentId: string;
    oldAssignmentId: string;
    newAssignmentId: string | null;
    oldInspectorUserId: string;
    newInspectorUserId: string | null;
    reason: string;
    action: 'SUPERSEDED' | 'REVOKED';
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  if (input.oldInspectorUserId === input.newInspectorUserId) {
    return;
  }
  const recipients = await filterActiveUserIds(
    [input.oldInspectorUserId],
    executor,
  );
  for (const recipientUserId of recipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: input.clientId,
        recipientUserId,
        type: 'INSPECTOR_VISIT_ASSIGNMENT_SUPERSEDED',
        title:
          input.action === 'REVOKED'
            ? 'Penugasan Inspeksi Handyman Dicabut'
            : 'Penugasan Inspeksi Handyman Digantikan',
        body: `Penugasan kunjungan inspeksi Anda telah ${input.action === 'REVOKED' ? 'dicabut' : 'digantikan'} (${input.reason}).`,
        sourceEntityType: 'INSPECTOR_VISIT_ASSIGNMENT',
        sourceEntityId: input.oldAssignmentId,
        sourceEventType: 'INSPECTOR_VISIT_ASSIGNMENT_SUPERSEDED',
        navigationTarget: null,
        metadata: {
          handymanRequestId: input.handymanRequestId,
          visitAppointmentId: input.visitAppointmentId,
          buildingId: input.buildingId,
          supersededAssignmentId: input.oldAssignmentId,
          replacementAssignmentId: input.newAssignmentId,
          action: input.action,
          reason: input.reason,
        },
      },
      executor,
    );
  }
}

export async function notifyInspectorAssignmentAccepted(
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    visitAppointmentId: string;
    assignmentId: string;
    assignedByUserId: string;
    respondedByUserId: string;
    respondedByWorkerId: string | null;
    respondedAt: Date;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const recipients = await filterActiveUserIds(
    [input.assignedByUserId],
    executor,
  );
  for (const recipientUserId of recipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: input.clientId,
        recipientUserId,
        type: 'INSPECTOR_VISIT_ASSIGNMENT_ACCEPTED',
        title: 'Penugasan Inspector Handyman Diterima (TERIMA)',
        body: 'Inspector telah mengonfirmasi TERIMA atas penugasan kunjungan inspeksi Handyman.',
        sourceEntityType: 'INSPECTOR_VISIT_ASSIGNMENT',
        sourceEntityId: input.assignmentId,
        sourceEventType: 'INSPECTOR_VISIT_ASSIGNMENT_ACCEPTED',
        navigationTarget: {
          type: 'INSPECTOR_VISIT_FIELD_WORK',
          id: input.visitAppointmentId,
        },
        metadata: {
          handymanRequestId: input.handymanRequestId,
          visitAppointmentId: input.visitAppointmentId,
          buildingId: input.buildingId,
          assignmentId: input.assignmentId,
          responseStatus: 'TERIMA',
          respondedByUserId: input.respondedByUserId,
          respondedByWorkerId: input.respondedByWorkerId,
          respondedAt: input.respondedAt.toISOString(),
          reassignmentRequired: false,
        },
      },
      executor,
    );
  }
}

export async function notifyInspectorAssignmentDeclined(
  input: {
    clientId: string;
    buildingId: string;
    handymanRequestId: string;
    visitAppointmentId: string;
    assignmentId: string;
    assignedByUserId: string;
    respondedByUserId: string;
    respondedByWorkerId: string | null;
    respondedAt: Date;
    declineReason: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<void> {
  const recipients = await filterActiveUserIds(
    [input.assignedByUserId],
    executor,
  );
  for (const recipientUserId of recipients) {
    await recordDeduplicatedAssignmentNotification(
      {
        clientId: input.clientId,
        recipientUserId,
        type: 'INSPECTOR_VISIT_ASSIGNMENT_DECLINED',
        title: 'Penugasan Inspector Handyman Ditolak (TIDAK_BISA)',
        body: `Inspector menolak penugasan kunjungan inspeksi dengan alasan: ${input.declineReason}. Penugasan ulang diperlukan.`,
        sourceEntityType: 'INSPECTOR_VISIT_ASSIGNMENT',
        sourceEntityId: input.assignmentId,
        sourceEventType: 'INSPECTOR_VISIT_ASSIGNMENT_DECLINED',
        navigationTarget: {
          type: 'INSPECTOR_VISIT_FIELD_WORK',
          id: input.visitAppointmentId,
        },
        metadata: {
          handymanRequestId: input.handymanRequestId,
          visitAppointmentId: input.visitAppointmentId,
          buildingId: input.buildingId,
          assignmentId: input.assignmentId,
          responseStatus: 'TIDAK_BISA',
          respondedByUserId: input.respondedByUserId,
          respondedByWorkerId: input.respondedByWorkerId,
          respondedAt: input.respondedAt.toISOString(),
          declineReason: input.declineReason,
          reassignmentRequired: true,
        },
      },
      executor,
    );
  }
}

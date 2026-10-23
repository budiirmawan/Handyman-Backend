import { getPool } from '../../database';
import { assignmentResponseRepository } from '../assignment-responses';
import { canAccessBuildingScopedResource } from '../context-access';
import {
  computeHandymanFieldInspectionAvailableActions,
  computeHandymanFieldJobAvailableActions,
} from '../handyman-field-feed/handyman-field-feed.service';
import { resolveHandymanAssignmentLead } from '../handyman-scope-assignments';
import { findMobileWorkOrderAssignmentsByWorkOrderId } from '../mobile-assignments';
import type { MobileAssignmentFeedItem } from '../mobile-assignments';
import { notificationNavigationTargetAmbiguousError } from './notification.errors';
import { notificationService } from './notification.service';
import type { PublicNotification } from './notification.types';

/**
 * CR-BE-RN21-NOTIFICATION-NAV-01 & CR-HM-ASSIGNMENT-RESPONSE-01 PART 02C —
 * Backend-owned navigation target resolution across Mobile Field Work and
 * Operations response notifications.
 */

export const NOTIFICATION_NAVIGATION_DESTINATIONS = [
  'FIELD_WORK',
  'OPERATIONS_WORK_ORDER',
  'OPERATIONS_EXECUTION_SCOPE',
  'OPERATIONS_INSPECTOR_VISIT',
] as const;

export type NotificationNavigationDestination =
  (typeof NOTIFICATION_NAVIGATION_DESTINATIONS)[number];

export type NotificationNavigationResolution =
  | {
      destination: 'FIELD_WORK';
      assignment: MobileAssignmentFeedItem;
    }
  | {
      destination: 'FIELD_WORK';
      assignmentType: 'EXECUTION_SCOPE_ASSIGNMENT';
      assignmentId: string;
      executionScopeId: string;
      handymanRequestId: string;
      responseStatus: string;
      respondedByUserId: string | null;
      respondedByWorkerId: string | null;
      respondedAt: string | null;
      declineReason: string | null;
      reassignmentRequired: boolean;
      availableActions: string[];
    }
  | {
      destination: 'FIELD_WORK';
      assignmentType: 'INSPECTOR_VISIT_ASSIGNMENT';
      assignmentId: string;
      visitAppointmentId: string;
      handymanRequestId: string;
      responseStatus: string;
      respondedByUserId: string | null;
      respondedByWorkerId: string | null;
      respondedAt: string | null;
      declineReason: string | null;
      reassignmentRequired: boolean;
      availableActions: string[];
    }
  | {
      destination: 'OPERATIONS_WORK_ORDER';
      workOrderId: string;
      assignmentId: string;
      workOrderStatus: string;
      assignmentStatus: string;
      responseStatus: string;
      respondedByUserId: string | null;
      respondedByWorkerId: string | null;
      respondedAt: string | null;
      declineReason: string | null;
      reassignmentRequired: boolean;
    }
  | {
      destination: 'OPERATIONS_EXECUTION_SCOPE';
      executionScopeId: string;
      handymanRequestId: string;
      assignmentId: string;
      assignmentStatus: string;
      responseStatus: string;
      respondedByUserId: string | null;
      respondedByWorkerId: string | null;
      respondedAt: string | null;
      declineReason: string | null;
      reassignmentRequired: boolean;
    }
  | {
      destination: 'OPERATIONS_INSPECTOR_VISIT';
      visitAppointmentId: string;
      handymanRequestId: string;
      assignmentId: string;
      assignmentStatus: string;
      responseStatus: string;
      respondedByUserId: string | null;
      respondedByWorkerId: string | null;
      respondedAt: string | null;
      declineReason: string | null;
      reassignmentRequired: boolean;
    };

export type NotificationNavigationTargetResult = {
  target: NotificationNavigationResolution | null;
};

async function resolveOperationsWorkOrderNavigationTarget(
  recipientUserId: string,
  workOrderId: string,
  assignmentId: string,
): Promise<NotificationNavigationTargetResult> {
  const pool = getPool();
  const res = await pool.query<{
    work_order_id: string;
    client_id: string;
    building_id: string;
    wo_status: string;
    assignment_id: string;
    assignment_status: string;
    response_status: string | null;
    responded_by_user_id: string | null;
    responded_by_worker_id: string | null;
    responded_at: Date | null;
    decline_reason: string | null;
  }>(
    `SELECT w.id AS work_order_id,
            w.client_id,
            w.building_id,
            w.status AS wo_status,
            a.id AS assignment_id,
            a.status AS assignment_status,
            COALESCE(ar.response_status, 'PENDING') AS response_status,
            ar.responded_by_user_id,
            ar.responded_by_worker_id,
            ar.responded_at,
            ar.decline_reason
       FROM work_orders w
       JOIN work_order_assignments a
         ON a.work_order_id = w.id
        AND a.id = $2
       LEFT JOIN handyman_assignment_responses ar
         ON ar.assignment_id = a.id
        AND ar.assignment_target_type = 'WORK_ORDER_ASSIGNMENT'
      WHERE w.id = $1
      LIMIT 1`,
    [workOrderId, assignmentId],
  );
  const row = res.rows[0];
  if (!row) {
    return { target: null };
  }
  const allowed = await canAccessBuildingScopedResource(recipientUserId, {
    clientId: row.client_id,
    buildingId: row.building_id,
  });
  if (!allowed) {
    return { target: null };
  }
  const responseStatus = row.response_status ?? 'PENDING';
  return {
    target: {
      destination: 'OPERATIONS_WORK_ORDER',
      workOrderId: row.work_order_id,
      assignmentId: row.assignment_id,
      workOrderStatus: row.wo_status,
      assignmentStatus: row.assignment_status,
      responseStatus,
      respondedByUserId: row.responded_by_user_id,
      respondedByWorkerId: row.responded_by_worker_id,
      respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
      declineReason: row.decline_reason,
      reassignmentRequired:
        row.assignment_status === 'ACTIVE' && responseStatus === 'TIDAK_BISA',
    },
  };
}

async function resolveExecutionScopeNavigationTarget(
  recipientUserId: string,
  notification: PublicNotification,
  executionScopeId: string,
): Promise<NotificationNavigationTargetResult> {
  const pool = getPool();
  const isOperationsEvent =
    notification.sourceEventType === 'EXECUTION_SCOPE_ASSIGNMENT_ACCEPTED' ||
    notification.sourceEventType === 'EXECUTION_SCOPE_ASSIGNMENT_DECLINED';

  if (isOperationsEvent) {
    const res = await pool.query<{
      execution_scope_id: string;
      handyman_request_id: string;
      client_id: string;
      building_id: string;
      assignment_id: string;
      assignment_status: string;
      response_status: string | null;
      responded_by_user_id: string | null;
      responded_by_worker_id: string | null;
      responded_at: Date | null;
      decline_reason: string | null;
    }>(
      `SELECT es.id AS execution_scope_id,
              es.handyman_request_id,
              es.client_id,
              es.building_id,
              a.id AS assignment_id,
              a.status AS assignment_status,
              COALESCE(ar.response_status, 'PENDING') AS response_status,
              ar.responded_by_user_id,
              ar.responded_by_worker_id,
              ar.responded_at,
              ar.decline_reason
         FROM handyman_execution_scopes es
         JOIN handyman_execution_scope_assignments a
           ON a.execution_scope_id = es.id
          AND a.id = $2
         LEFT JOIN handyman_assignment_responses ar
           ON ar.assignment_id = a.id
          AND ar.assignment_target_type = 'EXECUTION_SCOPE_ASSIGNMENT'
        WHERE es.id = $1
        LIMIT 1`,
      [executionScopeId, notification.sourceEntityId],
    );
    const row = res.rows[0];
    if (!row) {
      return { target: null };
    }
    const allowed = await canAccessBuildingScopedResource(recipientUserId, {
      clientId: row.client_id,
      buildingId: row.building_id,
    });
    if (!allowed) {
      return { target: null };
    }
    const responseStatus = row.response_status ?? 'PENDING';
    return {
      target: {
        destination: 'OPERATIONS_EXECUTION_SCOPE',
        executionScopeId: row.execution_scope_id,
        handymanRequestId: row.handyman_request_id,
        assignmentId: row.assignment_id,
        assignmentStatus: row.assignment_status,
        responseStatus,
        respondedByUserId: row.responded_by_user_id,
        respondedByWorkerId: row.responded_by_worker_id,
        respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
        declineReason: row.decline_reason,
        reassignmentRequired:
          row.assignment_status === 'ACTIVE' && responseStatus === 'TIDAK_BISA',
      },
    };
  }

  // Mobile Crew Lead navigation target
  const scopeRes = await pool.query<{
    id: string;
    handyman_request_id: string;
    client_id: string;
    building_id: string;
  }>(
    `SELECT id, handyman_request_id, client_id, building_id
       FROM handyman_execution_scopes
      WHERE id = $1
      LIMIT 1`,
    [executionScopeId],
  );
  const scope = scopeRes.rows[0];
  if (!scope) {
    return { target: null };
  }
  const allowed = await canAccessBuildingScopedResource(recipientUserId, {
    clientId: scope.client_id,
    buildingId: scope.building_id,
  });
  if (!allowed) {
    return { target: null };
  }

  let lead: Awaited<ReturnType<typeof resolveHandymanAssignmentLead>> = null;
  try {
    lead = await resolveHandymanAssignmentLead(
      executionScopeId,
      recipientUserId,
    );
  } catch {
    lead = null;
  }
  if (
    !lead ||
    lead.leadUserId !== recipientUserId ||
    lead.assignmentId !== notification.sourceEntityId
  ) {
    return { target: null };
  }

  const [resp, sessionRes] = await Promise.all([
    assignmentResponseRepository.findByAssignmentId(lead.assignmentId),
    pool.query<{ status: string }>(
      `SELECT status
         FROM handyman_work_sessions
        WHERE assignment_id = $1
          AND status IN ('CHECKED_IN', 'IN_PROGRESS', 'PAUSED', 'MATERIAL_RUN')
        ORDER BY checked_in_at DESC
        LIMIT 1`,
      [lead.assignmentId],
    ),
  ]);
  const responseStatus = resp?.responseStatus ?? 'PENDING';
  if (responseStatus === 'TIDAK_BISA') {
    return { target: null };
  }
  const activeSessionStatus = sessionRes.rows[0]?.status ?? null;

  return {
    target: {
      destination: 'FIELD_WORK',
      assignmentType: 'EXECUTION_SCOPE_ASSIGNMENT',
      assignmentId: lead.assignmentId,
      executionScopeId,
      handymanRequestId: scope.handyman_request_id,
      responseStatus,
      respondedByUserId: resp?.respondedByUserId ?? null,
      respondedByWorkerId: resp?.respondedByWorkerId ?? null,
      respondedAt: resp?.respondedAt ? resp.respondedAt.toISOString() : null,
      declineReason: resp?.declineReason ?? null,
      reassignmentRequired: false,
      availableActions: computeHandymanFieldJobAvailableActions(
        responseStatus,
        activeSessionStatus,
      ),
    },
  };
}

async function resolveInspectorVisitNavigationTarget(
  recipientUserId: string,
  notification: PublicNotification,
  visitAppointmentId: string,
): Promise<NotificationNavigationTargetResult> {
  const pool = getPool();
  const isOperationsEvent =
    notification.sourceEventType === 'INSPECTOR_VISIT_ASSIGNMENT_ACCEPTED' ||
    notification.sourceEventType === 'INSPECTOR_VISIT_ASSIGNMENT_DECLINED';

  const res = await pool.query<{
    visit_appointment_id: string;
    handyman_request_id: string;
    client_id: string;
    building_id: string;
    assignment_id: string;
    assignment_status: string;
    inspector_user_id: string;
    response_status: string | null;
    responded_by_user_id: string | null;
    responded_by_worker_id: string | null;
    responded_at: Date | null;
    decline_reason: string | null;
  }>(
    `SELECT v.id AS visit_appointment_id,
            v.handyman_request_id,
            v.client_id,
            v.building_id,
            ia.id AS assignment_id,
            ia.status AS assignment_status,
            ia.inspector_user_id,
            COALESCE(ar.response_status, 'PENDING') AS response_status,
            ar.responded_by_user_id,
            ar.responded_by_worker_id,
            ar.responded_at,
            ar.decline_reason
       FROM handyman_visit_appointments v
       JOIN handyman_inspector_assignments ia
         ON ia.visit_appointment_id = v.id
        AND ia.id = $2
       LEFT JOIN handyman_assignment_responses ar
         ON ar.assignment_id = ia.id
        AND ar.assignment_target_type = 'INSPECTOR_VISIT_ASSIGNMENT'
      WHERE v.id = $1
      LIMIT 1`,
    [visitAppointmentId, notification.sourceEntityId],
  );
  const row = res.rows[0];
  if (!row) {
    return { target: null };
  }
  const allowed = await canAccessBuildingScopedResource(recipientUserId, {
    clientId: row.client_id,
    buildingId: row.building_id,
  });
  if (!allowed) {
    return { target: null };
  }

  const responseStatus = row.response_status ?? 'PENDING';

  if (isOperationsEvent) {
    return {
      target: {
        destination: 'OPERATIONS_INSPECTOR_VISIT',
        visitAppointmentId: row.visit_appointment_id,
        handymanRequestId: row.handyman_request_id,
        assignmentId: row.assignment_id,
        assignmentStatus: row.assignment_status,
        responseStatus,
        respondedByUserId: row.responded_by_user_id,
        respondedByWorkerId: row.responded_by_worker_id,
        respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
        declineReason: row.decline_reason,
        reassignmentRequired:
          row.assignment_status === 'ACTIVE' && responseStatus === 'TIDAK_BISA',
      },
    };
  }

  // Mobile Inspector navigation target
  if (
    row.assignment_status !== 'ACTIVE' ||
    row.inspector_user_id !== recipientUserId ||
    responseStatus === 'TIDAK_BISA'
  ) {
    return { target: null };
  }

  return {
    target: {
      destination: 'FIELD_WORK',
      assignmentType: 'INSPECTOR_VISIT_ASSIGNMENT',
      assignmentId: row.assignment_id,
      visitAppointmentId: row.visit_appointment_id,
      handymanRequestId: row.handyman_request_id,
      responseStatus,
      respondedByUserId: row.responded_by_user_id,
      respondedByWorkerId: row.responded_by_worker_id,
      respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
      declineReason: row.decline_reason,
      reassignmentRequired: false,
      availableActions:
        computeHandymanFieldInspectionAvailableActions(responseStatus),
    },
  };
}

/**
 * Resolves the notification's explicit navigation target for the recipient.
 *
 * Throws `notificationNotFoundError` when the notification is not the
 * recipient's own (missing OR foreign — indistinguishable, never a leak) and
 * `notificationNavigationTargetAmbiguousError` when the target matches more
 * than one visible assignment.
 */
export async function resolveNotificationNavigationTarget(
  recipientUserId: string,
  notificationId: string,
): Promise<NotificationNavigationTargetResult> {
  const notification: PublicNotification =
    await notificationService.getNotification(recipientUserId, notificationId);

  const target = notification.navigationTarget;
  if (!target) {
    return { target: null };
  }

  if (target.type === 'EXECUTION_SCOPE_FIELD_WORK') {
    return resolveExecutionScopeNavigationTarget(
      recipientUserId,
      notification,
      target.id,
    );
  }

  if (target.type === 'INSPECTOR_VISIT_FIELD_WORK') {
    return resolveInspectorVisitNavigationTarget(
      recipientUserId,
      notification,
      target.id,
    );
  }

  if (target.type !== 'WORK_ORDER_FIELD_WORK') {
    return { target: null };
  }

  if (
    notification.sourceEventType === 'WORK_ORDER_ASSIGNMENT_ACCEPTED' ||
    notification.sourceEventType === 'WORK_ORDER_ASSIGNMENT_DECLINED'
  ) {
    return resolveOperationsWorkOrderNavigationTarget(
      recipientUserId,
      target.id,
      notification.sourceEntityId,
    );
  }

  const assignments = await findMobileWorkOrderAssignmentsByWorkOrderId(
    recipientUserId,
    target.id,
  );

  const filtered =
    notification.sourceEntityType === 'WORK_ORDER_ASSIGNMENT'
      ? assignments.filter(
          (item) =>
            item.id === notification.sourceEntityId &&
            item.assignee.responseStatus !== 'TIDAK_BISA',
        )
      : assignments;

  if (filtered.length === 0) {
    return { target: null };
  }

  if (filtered.length > 1) {
    throw notificationNavigationTargetAmbiguousError(
      notificationId,
      filtered.length,
    );
  }

  return {
    target: {
      destination: 'FIELD_WORK',
      assignment: filtered[0],
    },
  };
}

export const notificationNavigationService = {
  resolveNotificationNavigationTarget,
};

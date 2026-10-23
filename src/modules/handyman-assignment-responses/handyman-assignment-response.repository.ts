import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '../../database';
import { computeOutboundDeliveryIdempotencyKey } from '../notification-outbound-deliveries';
import type { PublicNotificationNavigationTarget } from '../notifications';
import {
  DEFAULT_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES,
  MAX_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES,
  MIN_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES,
  type AssignmentKind,
  type AssignmentResponseCode,
  type AssignmentResponseEventType,
  type AssignmentResponseStatus,
  type EffectiveAssignmentDeadlinePolicy,
  type HandymanAssignmentResponseEventRecord,
  type HandymanAssignmentResponseRecord,
} from './handyman-assignment-response.types';

type DbExecutor = Pick<PoolClient, 'query'>;

const RESPONSE_SELECT = `
  SELECT id,
         client_id,
         building_id,
         assignment_kind,
         assignment_id,
         execution_scope_id,
         handyman_request_id,
         visit_appointment_id,
         work_order_id,
         expected_responder_user_id,
         assigned_by_user_id,
         assigned_at,
         deadline_minutes,
         response_deadline_at,
         response_status,
         response_code,
         decline_reason,
         response_notes,
         responded_by_user_id,
         responded_at,
         superseded_at,
         superseded_by_assignment_id,
         version,
         created_at,
         updated_at
    FROM handyman_assignment_responses`;

const EVENT_SELECT = `
  SELECT id,
         client_id,
         building_id,
         assignment_response_id,
         assignment_kind,
         assignment_id,
         execution_scope_id,
         handyman_request_id,
         visit_appointment_id,
         work_order_id,
         event_type,
         response_status,
         response_code,
         reason,
         notes,
         actor_user_id,
         idempotency_key,
         occurred_at,
         created_at
    FROM handyman_assignment_response_events`;

function mapResponseRow(row: QueryResultRow): HandymanAssignmentResponseRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    assignmentKind: row.assignment_kind as AssignmentKind,
    assignmentId: row.assignment_id,
    executionScopeId: row.execution_scope_id,
    handymanRequestId: row.handyman_request_id,
    visitAppointmentId: row.visit_appointment_id,
    workOrderId: row.work_order_id,
    expectedResponderUserId: row.expected_responder_user_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: row.assigned_at,
    deadlineMinutes: Number(row.deadline_minutes),
    responseDeadlineAt: row.response_deadline_at,
    responseStatus: row.response_status as AssignmentResponseStatus,
    responseCode: (row.response_code as AssignmentResponseCode | null) ?? null,
    declineReason: row.decline_reason ?? null,
    responseNotes: row.response_notes ?? null,
    respondedByUserId: row.responded_by_user_id ?? null,
    respondedAt: row.responded_at ?? null,
    supersededAt: row.superseded_at ?? null,
    supersededByAssignmentId: row.superseded_by_assignment_id ?? null,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEventRow(row: QueryResultRow): HandymanAssignmentResponseEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    assignmentResponseId: row.assignment_response_id,
    assignmentKind: row.assignment_kind as AssignmentKind,
    assignmentId: row.assignment_id,
    executionScopeId: row.execution_scope_id ?? null,
    handymanRequestId: row.handyman_request_id ?? null,
    visitAppointmentId: row.visit_appointment_id ?? null,
    workOrderId: row.work_order_id ?? null,
    eventType: row.event_type as AssignmentResponseEventType,
    responseStatus: row.response_status as AssignmentResponseStatus,
    responseCode: (row.response_code as AssignmentResponseCode | null) ?? null,
    reason: row.reason ?? null,
    notes: row.notes ?? null,
    actorUserId: row.actor_user_id,
    idempotencyKey: row.idempotency_key ?? null,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function readEnvDefaultDeadlineMinutes(): {
  deadlineMinutes: number;
  fromEnv: boolean;
} {
  const raw = process.env.ASSIGNMENT_RESPONSE_DEADLINE_MINUTES?.trim();
  if (!raw) {
    return {
      deadlineMinutes: DEFAULT_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES,
      fromEnv: false,
    };
  }
  const parsed = Number(raw);
  if (
    Number.isInteger(parsed) &&
    parsed >= MIN_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES &&
    parsed <= MAX_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES
  ) {
    return { deadlineMinutes: parsed, fromEnv: true };
  }
  return {
    deadlineMinutes: DEFAULT_ASSIGNMENT_RESPONSE_DEADLINE_MINUTES,
    fromEnv: false,
  };
}

export async function getServerNow(
  executor: DbExecutor = getPool(),
): Promise<Date> {
  const res = await executor.query<{ now: Date }>(`SELECT NOW() AS now`);
  return res.rows[0].now;
}

export async function resolveEffectiveDeadlinePolicy(
  executor: DbExecutor = getPool(),
  clientId: string,
  buildingId?: string | null,
): Promise<EffectiveAssignmentDeadlinePolicy> {
  if (buildingId) {
    const bRes = await executor.query<{
      deadline_minutes: number;
      updated_by_user_id: string;
      updated_at: Date;
    }>(
      `SELECT deadline_minutes, updated_by_user_id, updated_at
         FROM handyman_assignment_response_policies
        WHERE client_id = $1 AND building_id = $2
        LIMIT 1`,
      [clientId, buildingId],
    );
    if (bRes.rows[0]) {
      return {
        clientId,
        buildingId,
        deadlineMinutes: Number(bRes.rows[0].deadline_minutes),
        source: 'BUILDING_POLICY',
        autoReassignEnabled: false,
        updatedByUserId: bRes.rows[0].updated_by_user_id,
        updatedAt: bRes.rows[0].updated_at.toISOString(),
      };
    }
  }

  const cRes = await executor.query<{
    deadline_minutes: number;
    updated_by_user_id: string;
    updated_at: Date;
  }>(
    `SELECT deadline_minutes, updated_by_user_id, updated_at
       FROM handyman_assignment_response_policies
      WHERE client_id = $1 AND building_id IS NULL
      LIMIT 1`,
    [clientId],
  );
  if (cRes.rows[0]) {
    return {
      clientId,
      buildingId: buildingId ?? null,
      deadlineMinutes: Number(cRes.rows[0].deadline_minutes),
      source: 'CLIENT_POLICY',
      autoReassignEnabled: false,
      updatedByUserId: cRes.rows[0].updated_by_user_id,
      updatedAt: cRes.rows[0].updated_at.toISOString(),
    };
  }

  const fallback = readEnvDefaultDeadlineMinutes();
  return {
    clientId,
    buildingId: buildingId ?? null,
    deadlineMinutes: fallback.deadlineMinutes,
    source: fallback.fromEnv ? 'ENV_DEFAULT' : 'SYSTEM_DEFAULT',
    autoReassignEnabled: false,
    updatedByUserId: null,
    updatedAt: null,
  };
}

export async function upsertDeadlinePolicy(
  executor: DbExecutor,
  input: {
    clientId: string;
    buildingId: string | null;
    deadlineMinutes: number;
    actorUserId: string;
  },
): Promise<EffectiveAssignmentDeadlinePolicy> {
  if (input.buildingId) {
    const res = await executor.query<{
      deadline_minutes: number;
      updated_by_user_id: string;
      updated_at: Date;
    }>(
      `INSERT INTO handyman_assignment_response_policies (
         id, client_id, building_id, deadline_minutes, auto_reassign_enabled, updated_by_user_id
       )
       VALUES ($1, $2, $3, $4, FALSE, $5)
       ON CONFLICT (client_id, building_id) WHERE building_id IS NOT NULL
       DO UPDATE SET
         deadline_minutes = EXCLUDED.deadline_minutes,
         updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_at = NOW()
       RETURNING deadline_minutes, updated_by_user_id, updated_at`,
      [
        randomUUID(),
        input.clientId,
        input.buildingId,
        input.deadlineMinutes,
        input.actorUserId,
      ],
    );
    return {
      clientId: input.clientId,
      buildingId: input.buildingId,
      deadlineMinutes: Number(res.rows[0].deadline_minutes),
      source: 'BUILDING_POLICY',
      autoReassignEnabled: false,
      updatedByUserId: res.rows[0].updated_by_user_id,
      updatedAt: res.rows[0].updated_at.toISOString(),
    };
  }

  const res = await executor.query<{
    deadline_minutes: number;
    updated_by_user_id: string;
    updated_at: Date;
  }>(
    `INSERT INTO handyman_assignment_response_policies (
       id, client_id, building_id, deadline_minutes, auto_reassign_enabled, updated_by_user_id
     )
     VALUES ($1, $2, NULL, $3, FALSE, $4)
     ON CONFLICT (client_id) WHERE building_id IS NULL
     DO UPDATE SET
       deadline_minutes = EXCLUDED.deadline_minutes,
       updated_by_user_id = EXCLUDED.updated_by_user_id,
       updated_at = NOW()
     RETURNING deadline_minutes, updated_by_user_id, updated_at`,
    [randomUUID(), input.clientId, input.deadlineMinutes, input.actorUserId],
  );
  return {
    clientId: input.clientId,
    buildingId: null,
    deadlineMinutes: Number(res.rows[0].deadline_minutes),
    source: 'CLIENT_POLICY',
    autoReassignEnabled: false,
    updatedByUserId: res.rows[0].updated_by_user_id,
    updatedAt: res.rows[0].updated_at.toISOString(),
  };
}

export async function insertPendingResponse(
  executor: DbExecutor,
  input: {
    clientId: string;
    buildingId: string;
    assignmentKind: AssignmentKind;
    assignmentId: string;
    executionScopeId?: string | null;
    handymanRequestId?: string | null;
    visitAppointmentId?: string | null;
    workOrderId?: string | null;
    expectedResponderUserId: string | null;
    assignedByUserId: string;
    assignedAt?: Date | null;
    deadlineMinutes: number;
  },
): Promise<HandymanAssignmentResponseRecord> {
  const res = await executor.query(
    `INSERT INTO handyman_assignment_responses (
       id,
       client_id,
       building_id,
       assignment_kind,
       assignment_id,
       execution_scope_id,
       handyman_request_id,
       visit_appointment_id,
       work_order_id,
       expected_responder_user_id,
       assigned_by_user_id,
       assigned_at,
       deadline_minutes,
       response_deadline_at,
       response_status
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       COALESCE($12::timestamptz, NOW()),
       $13::integer,
       COALESCE($12::timestamptz, NOW()) + make_interval(mins => $13::integer),
       'PENDING'
     )
     ON CONFLICT (assignment_id) DO UPDATE
       SET assignment_id = handyman_assignment_responses.assignment_id
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.assignmentKind,
      input.assignmentId,
      input.executionScopeId ?? null,
      input.handymanRequestId ?? null,
      input.visitAppointmentId ?? null,
      input.workOrderId ?? null,
      input.expectedResponderUserId,
      input.assignedByUserId,
      input.assignedAt ?? null,
      input.deadlineMinutes,
    ],
  );
  return mapResponseRow(res.rows[0]);
}

export async function appendResponseEvent(
  executor: DbExecutor,
  input: {
    clientId: string;
    buildingId: string;
    assignmentResponseId: string;
    assignmentKind: AssignmentKind;
    assignmentId: string;
    executionScopeId?: string | null;
    handymanRequestId?: string | null;
    visitAppointmentId?: string | null;
    workOrderId?: string | null;
    eventType: AssignmentResponseEventType;
    responseStatus: AssignmentResponseStatus;
    responseCode?: AssignmentResponseCode | null;
    reason?: string | null;
    notes?: string | null;
    actorUserId: string;
    idempotencyKey?: string | null;
  },
): Promise<HandymanAssignmentResponseEventRecord> {
  const res = await executor.query(
    `INSERT INTO handyman_assignment_response_events (
       id,
       client_id,
       building_id,
       assignment_response_id,
       assignment_kind,
       assignment_id,
       execution_scope_id,
       handyman_request_id,
       visit_appointment_id,
       work_order_id,
       event_type,
       response_status,
       response_code,
       reason,
       notes,
       actor_user_id,
       idempotency_key
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.assignmentResponseId,
      input.assignmentKind,
      input.assignmentId,
      input.executionScopeId ?? null,
      input.handymanRequestId ?? null,
      input.visitAppointmentId ?? null,
      input.workOrderId ?? null,
      input.eventType,
      input.responseStatus,
      input.responseCode ?? null,
      input.reason ?? null,
      input.notes ?? null,
      input.actorUserId,
      input.idempotencyKey ?? null,
    ],
  );
  return mapEventRow(res.rows[0]);
}

export async function findByAssignmentId(
  executor: DbExecutor = getPool(),
  assignmentId: string,
): Promise<HandymanAssignmentResponseRecord | null> {
  const res = await executor.query(
    `${RESPONSE_SELECT} WHERE assignment_id = $1`,
    [assignmentId],
  );
  return res.rows[0] ? mapResponseRow(res.rows[0]) : null;
}

export async function lockByAssignmentId(
  executor: DbExecutor,
  assignmentId: string,
): Promise<HandymanAssignmentResponseRecord | null> {
  const res = await executor.query(
    `${RESPONSE_SELECT} WHERE assignment_id = $1 FOR UPDATE`,
    [assignmentId],
  );
  return res.rows[0] ? mapResponseRow(res.rows[0]) : null;
}

export async function listByAssignmentIds(
  executor: DbExecutor = getPool(),
  assignmentIds: string[],
): Promise<HandymanAssignmentResponseRecord[]> {
  if (assignmentIds.length === 0) return [];
  const res = await executor.query(
    `${RESPONSE_SELECT} WHERE assignment_id = ANY($1::uuid[])`,
    [assignmentIds],
  );
  return res.rows.map(mapResponseRow);
}

export async function listResponsesByScope(
  executor: DbExecutor = getPool(),
  clientId: string,
  executionScopeId: string,
): Promise<HandymanAssignmentResponseRecord[]> {
  const res = await executor.query(
    `${RESPONSE_SELECT}
      WHERE client_id = $1 AND execution_scope_id = $2
      ORDER BY assigned_at DESC, id DESC`,
    [clientId, executionScopeId],
  );
  return res.rows.map(mapResponseRow);
}

export async function listEventsByScope(
  executor: DbExecutor = getPool(),
  clientId: string,
  executionScopeId: string,
): Promise<HandymanAssignmentResponseEventRecord[]> {
  const res = await executor.query(
    `${EVENT_SELECT}
      WHERE client_id = $1 AND execution_scope_id = $2
      ORDER BY occurred_at ASC,
               (CASE
                  WHEN event_type = 'ASSIGNMENT_SUPERSEDED' THEN 0
                  WHEN event_type = 'ASSIGNMENT_ISSUED' THEN 1
                  ELSE 2
                END) ASC,
               id ASC`,
    [clientId, executionScopeId],
  );
  return res.rows.map(mapEventRow);
}

export async function listResponsesByVisit(
  executor: DbExecutor = getPool(),
  clientId: string,
  visitAppointmentId: string,
): Promise<HandymanAssignmentResponseRecord[]> {
  const res = await executor.query(
    `${RESPONSE_SELECT}
      WHERE client_id = $1 AND visit_appointment_id = $2
      ORDER BY assigned_at DESC, id DESC`,
    [clientId, visitAppointmentId],
  );
  return res.rows.map(mapResponseRow);
}

export async function listEventsByVisit(
  executor: DbExecutor = getPool(),
  clientId: string,
  visitAppointmentId: string,
): Promise<HandymanAssignmentResponseEventRecord[]> {
  const res = await executor.query(
    `${EVENT_SELECT}
      WHERE client_id = $1 AND visit_appointment_id = $2
      ORDER BY occurred_at ASC,
               (CASE
                  WHEN event_type = 'ASSIGNMENT_SUPERSEDED' THEN 0
                  WHEN event_type = 'ASSIGNMENT_ISSUED' THEN 1
                  ELSE 2
                END) ASC,
               id ASC`,
    [clientId, visitAppointmentId],
  );
  return res.rows.map(mapEventRow);
}

export async function listResponsesByWorkOrder(
  executor: DbExecutor = getPool(),
  clientId: string,
  workOrderId: string,
): Promise<HandymanAssignmentResponseRecord[]> {
  const res = await executor.query(
    `${RESPONSE_SELECT}
      WHERE client_id = $1 AND work_order_id = $2
      ORDER BY assigned_at DESC, id DESC`,
    [clientId, workOrderId],
  );
  return res.rows.map(mapResponseRow);
}

export async function listEventsByWorkOrder(
  executor: DbExecutor = getPool(),
  clientId: string,
  workOrderId: string,
): Promise<HandymanAssignmentResponseEventRecord[]> {
  const res = await executor.query(
    `${EVENT_SELECT}
      WHERE client_id = $1 AND work_order_id = $2
      ORDER BY occurred_at ASC,
               (CASE
                  WHEN event_type = 'ASSIGNMENT_SUPERSEDED' THEN 0
                  WHEN event_type = 'ASSIGNMENT_ISSUED' THEN 1
                  ELSE 2
                END) ASC,
               id ASC`,
    [clientId, workOrderId],
  );
  return res.rows.map(mapEventRow);
}

export async function findEventByIdempotency(
  executor: DbExecutor,
  clientId: string,
  assignmentId: string,
  eventType: AssignmentResponseEventType,
  idempotencyKey: string,
): Promise<HandymanAssignmentResponseEventRecord | null> {
  const res = await executor.query(
    `${EVENT_SELECT}
      WHERE client_id = $1
        AND assignment_id = $2
        AND event_type = $3
        AND idempotency_key = $4
      LIMIT 1`,
    [clientId, assignmentId, eventType, idempotencyKey],
  );
  return res.rows[0] ? mapEventRow(res.rows[0]) : null;
}

export async function markAccepted(
  executor: DbExecutor,
  id: string,
  actorUserId: string,
  notes: string | null,
): Promise<HandymanAssignmentResponseRecord | null> {
  const res = await executor.query(
    `UPDATE handyman_assignment_responses
        SET response_status = 'ACCEPTED',
            response_code = 'TERIMA',
            response_notes = $3,
            responded_by_user_id = $2,
            responded_at = NOW(),
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1 AND response_status = 'PENDING'
      RETURNING *`,
    [id, actorUserId, notes],
  );
  return res.rows[0] ? mapResponseRow(res.rows[0]) : null;
}

export async function markDeclined(
  executor: DbExecutor,
  id: string,
  actorUserId: string,
  reason: string,
  notes: string | null,
): Promise<HandymanAssignmentResponseRecord | null> {
  const res = await executor.query(
    `UPDATE handyman_assignment_responses
        SET response_status = 'DECLINED',
            response_code = 'TIDAK_BISA',
            decline_reason = $3,
            response_notes = $4,
            responded_by_user_id = $2,
            responded_at = NOW(),
            version = version + 1,
            updated_at = NOW()
      WHERE id = $1 AND response_status = 'PENDING'
      RETURNING *`,
    [id, actorUserId, reason, notes],
  );
  return res.rows[0] ? mapResponseRow(res.rows[0]) : null;
}

/**
 * Marks a prior assignment's response envelope superseded when reassigned/revoked.
 * - If still `PENDING`, transitions `response_status -> 'SUPERSEDED'` so the
 *   former worker can never submit a late/stale response.
 * - If already `ACCEPTED` or `DECLINED`, preserves `response_status` and
 *   `decline_reason` as immutable historical truth while stamping
 *   `superseded_at` and `superseded_by_assignment_id`.
 */
export async function markAssignmentSuperseded(
  executor: DbExecutor,
  assignmentId: string,
  supersededByAssignmentId: string | null,
): Promise<HandymanAssignmentResponseRecord | null> {
  const res = await executor.query(
    `UPDATE handyman_assignment_responses
        SET response_status = CASE
              WHEN response_status = 'PENDING' THEN 'SUPERSEDED'
              ELSE response_status
            END,
            superseded_at = COALESCE(superseded_at, NOW()),
            superseded_by_assignment_id = COALESCE($2::uuid, superseded_by_assignment_id),
            version = version + 1,
            updated_at = NOW()
      WHERE assignment_id = $1
      RETURNING *`,
    [assignmentId, supersededByAssignmentId],
  );
  return res.rows[0] ? mapResponseRow(res.rows[0]) : null;
}

/**
 * Emits an authoritative, deduplicated `IN_APP` notification inside the
 * caller's database transaction (`executor`), plus an idempotent `PUSH`
 * outbound delivery intent row ONLY when the recipient already owns at least
 * one `ACTIVE` mobile push token registration (`mobile_push_tokens`).
 *
 * Guarantees:
 *   - Zero duplicate `IN_APP` rows for the same `(recipient, entity, event)`.
 *   - Zero leakage to unassigned workers.
 *   - Atomic rollback if the enclosing assignment/response transaction aborts.
 */
export async function emitTargetedInAppNotificationTx(
  executor: DbExecutor,
  input: {
    clientId: string;
    buildingId: string;
    recipientUserId: string;
    type: string;
    title: string;
    body: string;
    sourceEntityType: string;
    sourceEntityId: string;
    sourceEventType: string;
    metadata: Record<string, unknown>;
    navigationTarget?: PublicNotificationNavigationTarget | null;
    enqueuePushIfRegistered?: boolean;
  },
): Promise<{ created: boolean; notificationId: string; pushIntentCreated: boolean }> {
  const existing = await executor.query<{ id: string }>(
    `SELECT id
       FROM notifications
      WHERE recipient_user_id = $1
        AND source_entity_type = $2
        AND source_entity_id = $3
        AND source_event_type = $4
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [
      input.recipientUserId,
      input.sourceEntityType,
      input.sourceEntityId,
      input.sourceEventType,
    ],
  );
  let notificationId = existing.rows[0]?.id ?? '';
  let created = false;
  if (!notificationId) {
    notificationId = randomUUID();
    await executor.query(
      `INSERT INTO notifications (
         id, client_id, recipient_user_id, type, channel, status, title, body,
         source_entity_type, source_entity_id, source_event_type, template_key,
         metadata, navigation_target_type, navigation_target_id
       )
       VALUES ($1,$2,$3,$4,'IN_APP','UNREAD',$5,$6,$7,$8,$9,NULL,$10,$11,$12)`,
      [
        notificationId,
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
    created = true;
  }

  let pushIntentCreated = false;
  if (input.enqueuePushIfRegistered) {
    const activeDevices = await executor.query<{ id: string }>(
      `SELECT id
         FROM mobile_push_tokens
        WHERE user_id = $1 AND status = 'ACTIVE'
        LIMIT 1`,
      [input.recipientUserId],
    );
    if (activeDevices.rows.length > 0) {
      const idempotencyKey = computeOutboundDeliveryIdempotencyKey({
        sourceEventType: input.sourceEventType,
        sourceEntityId: input.sourceEntityId,
        channel: 'PUSH',
        recipientUserId: input.recipientUserId,
        templateKey: input.type,
      });
      const pushInsert = await executor.query<{ id: string }>(
        `INSERT INTO notification_outbound_deliveries (
           id, client_id, building_id, recipient_user_id, channel, template_key,
           source_event_type, source_entity_type, source_entity_id,
           subject, message, recipient_address, idempotency_key
         )
         VALUES ($1,$2,$3,$4,'PUSH',NULL,$5,$6,$7,NULL,$8,$9,$10)
         ON CONFLICT (client_id, channel, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          input.clientId,
          input.buildingId,
          input.recipientUserId,
          input.sourceEventType,
          input.sourceEntityType,
          input.sourceEntityId,
          `${input.title} — ${input.body}`.slice(0, 240),
          `user:${input.recipientUserId}`,
          idempotencyKey,
        ],
      );
      pushIntentCreated = pushInsert.rows.length > 0;
    }
  }

  return { created, notificationId, pushIntentCreated };
}

/**
 * Resolves exact Operations recipients for a Building when a worker declines
 * (`TIDAK_BISA`) an assignment:
 *   1. `assignedByUserId` (if ACTIVE and distinct from the declining worker),
 *   2. Any ACTIVE user explicitly assigned to `buildingId` (`user_building_assignments`)
 *      holding the Operations management permission (`permissionCode`) who is
 *      NOT a Handyman worker on the declined crew/profile and NOT `excludeUserId`.
 */
export async function resolveOperationsDeclineRecipients(
  executor: DbExecutor,
  input: {
    clientId: string;
    buildingId: string;
    assignedByUserId: string;
    excludeUserId: string;
    permissionCode: 'tenant_company.manage' | 'work_order.manage';
  },
): Promise<string[]> {
  const recipients = new Set<string>();

  if (input.assignedByUserId !== input.excludeUserId) {
    const assignerActive = await executor.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE'`,
      [input.assignedByUserId],
    );
    if (assignerActive.rows[0]) {
      recipients.add(assignerActive.rows[0].id);
    }
  }

  // Also include active Building-scoped Operations managers (excluding any user
  // linked to a workforce_profile so sibling field workers holding broad test
  // roles never receive Operations management alerts).
  const opsManagers = await executor.query<{ user_id: string }>(
    `SELECT DISTINCT u.id AS user_id
       FROM users u
       JOIN user_building_assignments uba
         ON uba.user_id = u.id
        AND uba.building_id = $2
        AND uba.status = 'ACTIVE'
       JOIN buildings b
         ON b.id = uba.building_id
        AND b.status = 'ACTIVE'
       JOIN properties prop
         ON prop.id = b.property_id
        AND prop.client_id = $1
        AND prop.status = 'ACTIVE'
       JOIN user_role_assignments ura
         ON ura.user_id = u.id
       JOIN roles r
         ON r.id = ura.role_id
        AND r.status = 'ACTIVE'
       JOIN role_permission_assignments rpa
         ON rpa.role_id = r.id
       JOIN permissions perm
         ON perm.id = rpa.permission_id
        AND perm.code = $3
       LEFT JOIN workforce_profiles wp
         ON wp.user_id = u.id
      WHERE u.status = 'ACTIVE'
        AND u.id <> $4
        AND wp.id IS NULL
      ORDER BY u.id ASC`,
    [
      input.clientId,
      input.buildingId,
      input.permissionCode,
      input.excludeUserId,
    ],
  );
  for (const row of opsManagers.rows) {
    recipients.add(row.user_id);
  }

  return [...recipients];
}

export const handymanAssignmentResponseRepository = {
  getServerNow,
  resolveEffectiveDeadlinePolicy,
  upsertDeadlinePolicy,
  insertPendingResponse,
  appendResponseEvent,
  findByAssignmentId,
  lockByAssignmentId,
  listByAssignmentIds,
  listResponsesByScope,
  listEventsByScope,
  listResponsesByVisit,
  listEventsByVisit,
  listResponsesByWorkOrder,
  listEventsByWorkOrder,
  findEventByIdempotency,
  markAccepted,
  markDeclined,
  markAssignmentSuperseded,
  emitTargetedInAppNotificationTx,
  resolveOperationsDeclineRecipients,
};

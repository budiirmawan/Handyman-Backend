import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  EnsurePendingAssignmentResponseInput,
  HandymanAssignmentResponseEventRecord,
  HandymanAssignmentResponseEventType,
  HandymanAssignmentResponseRecord,
  HandymanAssignmentResponseStatus,
  HandymanAssignmentTargetType,
  PublicAssignmentResponseEvent,
  RecordAssignmentDecisionInput,
} from './assignment-response.types';

type AssignmentResponseRow = {
  id: string;
  client_id: string;
  building_id: string;
  assignment_target_type: HandymanAssignmentTargetType;
  assignment_id: string;
  work_order_id: string | null;
  handyman_request_id: string | null;
  execution_scope_id: string | null;
  visit_appointment_id: string | null;
  assigned_by_user_id: string;
  assigned_at: Date;
  response_status: HandymanAssignmentResponseStatus;
  responded_by_user_id: string | null;
  responded_by_worker_id: string | null;
  responded_at: Date | null;
  decline_reason: string | null;
  response_notes: string | null;
  linked_work_order_action_id: string | null;
  idempotency_key: string | null;
  client_idempotency_key: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

type AssignmentResponseEventRow = {
  id: string;
  response_id: string;
  client_id: string;
  building_id: string;
  assignment_target_type: HandymanAssignmentTargetType;
  assignment_id: string;
  work_order_id: string | null;
  handyman_request_id: string | null;
  execution_scope_id: string | null;
  visit_appointment_id: string | null;
  event_type: HandymanAssignmentResponseEventType;
  previous_status: HandymanAssignmentResponseStatus | null;
  new_status: HandymanAssignmentResponseStatus;
  decline_reason: string | null;
  notes: string | null;
  actor_user_id: string;
  actor_worker_id: string | null;
  idempotency_key: string;
  occurred_at: Date;
};

const RESPONSE_SELECT = `
  id,
  client_id,
  building_id,
  assignment_target_type,
  assignment_id,
  work_order_id,
  handyman_request_id,
  execution_scope_id,
  visit_appointment_id,
  assigned_by_user_id,
  assigned_at,
  response_status,
  responded_by_user_id,
  responded_by_worker_id,
  responded_at,
  decline_reason,
  response_notes,
  linked_work_order_action_id,
  idempotency_key,
  client_idempotency_key,
  version,
  created_at,
  updated_at
`;

const EVENT_SELECT = `
  id,
  response_id,
  client_id,
  building_id,
  assignment_target_type,
  assignment_id,
  work_order_id,
  handyman_request_id,
  execution_scope_id,
  visit_appointment_id,
  event_type,
  previous_status,
  new_status,
  decline_reason,
  notes,
  actor_user_id,
  actor_worker_id,
  idempotency_key,
  occurred_at
`;

function mapResponseRow(
  row: AssignmentResponseRow,
): HandymanAssignmentResponseRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    assignmentTargetType: row.assignment_target_type,
    assignmentId: row.assignment_id,
    workOrderId: row.work_order_id,
    handymanRequestId: row.handyman_request_id,
    executionScopeId: row.execution_scope_id,
    visitAppointmentId: row.visit_appointment_id,
    assignedByUserId: row.assigned_by_user_id,
    assignedAt: row.assigned_at,
    responseStatus: row.response_status,
    respondedByUserId: row.responded_by_user_id,
    respondedByWorkerId: row.responded_by_worker_id,
    respondedAt: row.responded_at,
    declineReason: row.decline_reason,
    responseNotes: row.response_notes,
    linkedWorkOrderActionId: row.linked_work_order_action_id,
    idempotencyKey: row.idempotency_key,
    clientIdempotencyKey: row.client_idempotency_key,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEventRow(
  row: AssignmentResponseEventRow,
): HandymanAssignmentResponseEventRecord {
  return {
    id: row.id,
    responseId: row.response_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    assignmentTargetType: row.assignment_target_type,
    assignmentId: row.assignment_id,
    workOrderId: row.work_order_id,
    handymanRequestId: row.handyman_request_id,
    executionScopeId: row.execution_scope_id,
    visitAppointmentId: row.visit_appointment_id,
    eventType: row.event_type,
    previousStatus: row.previous_status,
    newStatus: row.new_status,
    declineReason: row.decline_reason,
    notes: row.notes,
    actorUserId: row.actor_user_id,
    actorWorkerId: row.actor_worker_id,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at,
  };
}

export function toPublicAssignmentResponseEvent(
  record: HandymanAssignmentResponseEventRecord,
): PublicAssignmentResponseEvent {
  return {
    id: record.id,
    responseId: record.responseId,
    assignmentTargetType: record.assignmentTargetType,
    assignmentId: record.assignmentId,
    workOrderId: record.workOrderId,
    handymanRequestId: record.handymanRequestId,
    executionScopeId: record.executionScopeId,
    visitAppointmentId: record.visitAppointmentId,
    eventType: record.eventType,
    previousStatus: record.previousStatus,
    newStatus: record.newStatus,
    declineReason: record.declineReason,
    notes: record.notes,
    actorUserId: record.actorUserId,
    actorWorkerId: record.actorWorkerId,
    occurredAt: record.occurredAt.toISOString(),
  };
}

async function findByAssignmentId(
  assignmentId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanAssignmentResponseRecord | null> {
  const result = await executor.query<AssignmentResponseRow>(
    `SELECT ${RESPONSE_SELECT}
       FROM handyman_assignment_responses
      WHERE assignment_id = $1`,
    [assignmentId],
  );
  const row = result.rows[0];
  return row ? mapResponseRow(row) : null;
}

async function findByAssignmentIdForUpdate(
  assignmentId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanAssignmentResponseRecord | null> {
  const result = await executor.query<AssignmentResponseRow>(
    `SELECT ${RESPONSE_SELECT}
       FROM handyman_assignment_responses
      WHERE assignment_id = $1
      FOR UPDATE`,
    [assignmentId],
  );
  const row = result.rows[0];
  return row ? mapResponseRow(row) : null;
}

/**
 * CR-HM-FIELD-OPS-ACK-01 PART 01 — resolves a FINALIZED decision previously
 * written with the SAME caller-supplied key by the SAME actor. Used to stop an
 * offline/concurrent device replay from finalizing a DIFFERENT assignment
 * after reassignment. Legacy rows (NULL key) are never matched.
 */
async function findFinalizedByClientKey(
  actorUserId: string,
  clientIdempotencyKey: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanAssignmentResponseRecord | null> {
  const result = await executor.query<AssignmentResponseRow>(
    `SELECT ${RESPONSE_SELECT}
       FROM handyman_assignment_responses
      WHERE responded_by_user_id = $1
        AND client_idempotency_key = $2
        AND response_status IN ('TERIMA', 'TIDAK_BISA')
      ORDER BY updated_at ASC, id ASC
      LIMIT 1`,
    [actorUserId, clientIdempotencyKey],
  );
  const row = result.rows[0];
  return row ? mapResponseRow(row) : null;
}

async function findByAssignmentIds(
  assignmentIds: string[],
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<Map<string, HandymanAssignmentResponseRecord>> {
  const map = new Map<string, HandymanAssignmentResponseRecord>();
  if (assignmentIds.length === 0) {
    return map;
  }

  const result = await executor.query<AssignmentResponseRow>(
    `SELECT ${RESPONSE_SELECT}
       FROM handyman_assignment_responses
      WHERE assignment_id = ANY($1::uuid[])`,
    [assignmentIds],
  );
  for (const row of result.rows) {
    map.set(row.assignment_id, mapResponseRow(row));
  }
  return map;
}

/**
 * Ensures a canonical `PENDING` response row and `ASSIGNMENT_PENDING_CREATED`
 * event exist for the given assignment ID. Safe to call both during initial
 * assignment/reassignment creation and lazily when encountering legacy/raw-SQL
 * assignment rows.
 */
async function ensurePendingForAssignment(
  input: EnsurePendingAssignmentResponseInput,
  executor: Pick<PoolClient, 'query'> = getPool(),
  lockForUpdate = false,
): Promise<HandymanAssignmentResponseRecord> {
  const responseId = randomUUID();
  const assignedAt = input.assignedAt ?? new Date();
  await executor.query(
    `INSERT INTO handyman_assignment_responses (
       id, client_id, building_id, assignment_target_type, assignment_id,
       work_order_id, handyman_request_id, execution_scope_id,
       visit_appointment_id, assigned_by_user_id, assigned_at, response_status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'PENDING')
     ON CONFLICT (assignment_id) DO NOTHING`,
    [
      responseId,
      input.clientId,
      input.buildingId,
      input.assignmentTargetType,
      input.assignmentId,
      input.workOrderId ?? null,
      input.handymanRequestId ?? null,
      input.executionScopeId ?? null,
      input.visitAppointmentId ?? null,
      input.assignedByUserId,
      assignedAt,
    ],
  );

  const record = lockForUpdate
    ? await findByAssignmentIdForUpdate(input.assignmentId, executor)
    : await findByAssignmentId(input.assignmentId, executor);

  if (!record) {
    throw new Error(
      `Failed to ensure handyman_assignment_responses row for assignment ${input.assignmentId}`,
    );
  }

  await executor.query(
    `INSERT INTO handyman_assignment_response_events (
       id, response_id, client_id, building_id, assignment_target_type,
       assignment_id, work_order_id, handyman_request_id, execution_scope_id,
       visit_appointment_id, event_type, previous_status, new_status,
       decline_reason, notes, actor_user_id, actor_worker_id, idempotency_key,
       occurred_at
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, 'ASSIGNMENT_PENDING_CREATED', NULL, 'PENDING',
       NULL, NULL, $11, NULL, $12,
       $13
     )
     ON CONFLICT (assignment_id, idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      record.id,
      record.clientId,
      record.buildingId,
      record.assignmentTargetType,
      record.assignmentId,
      record.workOrderId,
      record.handymanRequestId,
      record.executionScopeId,
      record.visitAppointmentId,
      input.assignedByUserId,
      `PENDING:${record.assignmentId}`,
      assignedAt,
    ],
  );

  return record;
}

/**
 * Transitions a `PENDING` response row to `TERIMA` or `TIDAK_BISA` and appends
 * the corresponding decision event in `handyman_assignment_response_events`.
 */
async function recordDecision(
  input: RecordAssignmentDecisionInput,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanAssignmentResponseRecord> {
  const respondedAt = input.respondedAt ?? new Date();
  const declineReason =
    input.decision === 'TIDAK_BISA' ? (input.declineReason ?? null) : null;
  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `${input.decision}:${input.assignmentId}`;

  const updated = await executor.query<AssignmentResponseRow>(
    `UPDATE handyman_assignment_responses
        SET response_status = $2,
            responded_by_user_id = $3,
            responded_by_worker_id = $4,
            responded_at = $5,
            decline_reason = $6,
            response_notes = $7,
            linked_work_order_action_id = COALESCE($8, linked_work_order_action_id),
            idempotency_key = $9,
            client_idempotency_key = COALESCE($10, client_idempotency_key),
            version = version + 1,
            updated_at = NOW()
      WHERE assignment_id = $1
      RETURNING ${RESPONSE_SELECT}`,
    [
      input.assignmentId,
      input.decision,
      input.actorUserId,
      input.actorWorkerId ?? null,
      respondedAt,
      declineReason,
      input.notes ?? null,
      input.linkedWorkOrderActionId ?? null,
      idempotencyKey,
      input.clientIdempotencyKey?.trim() || null,
    ],
  );

  const row = updated.rows[0];
  if (!row) {
    throw new Error(
      `handyman_assignment_responses row not found for assignment ${input.assignmentId}`,
    );
  }
  const record = mapResponseRow(row);

  const eventType: HandymanAssignmentResponseEventType =
    input.decision === 'TERIMA' ? 'ASSIGNMENT_ACCEPTED' : 'ASSIGNMENT_DECLINED';

  await executor.query(
    `INSERT INTO handyman_assignment_response_events (
       id, response_id, client_id, building_id, assignment_target_type,
       assignment_id, work_order_id, handyman_request_id, execution_scope_id,
       visit_appointment_id, event_type, previous_status, new_status,
       decline_reason, notes, actor_user_id, actor_worker_id, idempotency_key,
       occurred_at
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, $11, 'PENDING', $12,
       $13, $14, $15, $16, $17,
       $18
     )
     ON CONFLICT (assignment_id, idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      record.id,
      record.clientId,
      record.buildingId,
      record.assignmentTargetType,
      record.assignmentId,
      record.workOrderId,
      record.handymanRequestId,
      record.executionScopeId,
      record.visitAppointmentId,
      eventType,
      input.decision,
      declineReason,
      input.notes ?? null,
      input.actorUserId,
      input.actorWorkerId ?? null,
      `DECISION:${record.assignmentId}`,
      respondedAt,
    ],
  );

  return record;
}

/**
 * Records an `ASSIGNMENT_SUPERSEDED` decision history event on an old
 * assignment when it is deactivated or replaced by reassignment, while
 * preserving its `handyman_assignment_responses` status (`PENDING`, `TERIMA`,
 * or `TIDAK_BISA`) untouched as historical audit.
 */
async function recordSupersededEvent(
  ensureInput: EnsurePendingAssignmentResponseInput,
  actorUserId: string,
  notes: string | null = null,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanAssignmentResponseRecord> {
  const current = await ensurePendingForAssignment(ensureInput, executor, true);
  await executor.query(
    `INSERT INTO handyman_assignment_response_events (
       id, response_id, client_id, building_id, assignment_target_type,
       assignment_id, work_order_id, handyman_request_id, execution_scope_id,
       visit_appointment_id, event_type, previous_status, new_status,
       decline_reason, notes, actor_user_id, actor_worker_id, idempotency_key,
       occurred_at
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9,
       $10, 'ASSIGNMENT_SUPERSEDED', $11, $11,
       $12, $13, $14, NULL, $15,
       NOW()
     )
     ON CONFLICT (assignment_id, idempotency_key) DO NOTHING`,
    [
      randomUUID(),
      current.id,
      current.clientId,
      current.buildingId,
      current.assignmentTargetType,
      current.assignmentId,
      current.workOrderId,
      current.handymanRequestId,
      current.executionScopeId,
      current.visitAppointmentId,
      current.responseStatus,
      current.declineReason,
      notes,
      actorUserId,
      `SUPERSEDED:${current.assignmentId}`,
    ],
  );
  return current;
}

async function listEventsByAssignmentId(
  assignmentId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanAssignmentResponseEventRecord[]> {
  const result = await executor.query<AssignmentResponseEventRow>(
    `SELECT ${EVENT_SELECT}
       FROM handyman_assignment_response_events
      WHERE assignment_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [assignmentId],
  );
  return result.rows.map(mapEventRow);
}

export const assignmentResponseRepository = {
  ensurePendingForAssignment,
  findByAssignmentId,
  findByAssignmentIdForUpdate,
  findByAssignmentIds,
  findFinalizedByClientKey,
  listEventsByAssignmentId,
  recordDecision,
  recordSupersededEvent,
  toPublicAssignmentResponseEvent,
};

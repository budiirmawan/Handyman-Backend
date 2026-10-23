import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanHelperAttendanceActorRole,
  HandymanHelperAttendanceConfirmationRecord,
  HandymanHelperAttendanceEventRecord,
  HandymanHelperAttendanceEventType,
  HandymanHelperAttendanceStatus,
  HandymanHelperPersonnelChangeType,
  HandymanHelperRosterSource,
  HandymanScopeHelperPersonnelChangeRecord,
} from './handyman-helper-attendance.types';

type Executor = Pick<PoolClient, 'query'>;

function toIso(val: unknown): string {
  if (val instanceof Date) return val.toISOString();
  return String(val);
}

function toNullableIso(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  return toIso(val);
}

function mapPersonnelChange(
  row: QueryResultRow,
): HandymanScopeHelperPersonnelChangeRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    handymanRequestId: row.handyman_request_id,
    executionScopeId: row.execution_scope_id,
    workOrderId: row.work_order_id ?? null,
    assignmentId: row.assignment_id,
    crewId: row.crew_id,
    workSessionId: row.work_session_id ?? null,
    changeType: row.change_type as HandymanHelperPersonnelChangeType,
    targetHelperWorkerId: row.target_helper_worker_id ?? null,
    targetHelperUserId: row.target_helper_user_id ?? null,
    replacedHelperWorkerId: row.replaced_helper_worker_id ?? null,
    replacedHelperUserId: row.replaced_helper_user_id ?? null,
    reason: row.reason,
    authorizedByUserId: row.authorized_by_user_id,
    authorizedAt: toIso(row.authorized_at),
    idempotencyKey: row.idempotency_key,
    createdAt: toIso(row.created_at),
  };
}

function mapConfirmation(
  row: QueryResultRow,
): HandymanHelperAttendanceConfirmationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    buildingId: row.building_id,
    handymanRequestId: row.handyman_request_id,
    executionScopeId: row.execution_scope_id,
    workOrderId: row.work_order_id ?? null,
    assignmentId: row.assignment_id,
    workSessionId: row.work_session_id,
    helperWorkerId: row.helper_worker_id,
    helperUserId: row.helper_user_id ?? null,
    rosterSource: row.roster_source as HandymanHelperRosterSource,
    personnelChangeId: row.personnel_change_id ?? null,
    attendanceStatus: row.attendance_status as HandymanHelperAttendanceStatus,
    confirmedByUserId: row.confirmed_by_user_id,
    confirmedByWorkerId: row.confirmed_by_worker_id ?? null,
    firstConfirmedAt: toIso(row.first_confirmed_at),
    lastConfirmedAt: toIso(row.last_confirmed_at),
    confirmationCount: Number(row.confirmation_count),
    latestNotes: row.latest_notes ?? null,
    latestCorrectionReason: row.latest_correction_reason ?? null,
    version: Number(row.version),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEvent(row: QueryResultRow): HandymanHelperAttendanceEventRecord {
  return {
    id: row.id,
    confirmationId: row.confirmation_id,
    clientId: row.client_id,
    buildingId: row.building_id,
    handymanRequestId: row.handyman_request_id,
    executionScopeId: row.execution_scope_id,
    workOrderId: row.work_order_id ?? null,
    workSessionId: row.work_session_id,
    helperWorkerId: row.helper_worker_id,
    helperUserId: row.helper_user_id ?? null,
    eventType: row.event_type as HandymanHelperAttendanceEventType,
    previousStatus:
      (row.previous_status as HandymanHelperAttendanceStatus | null) ?? null,
    newStatus: row.new_status as HandymanHelperAttendanceStatus,
    notes: row.notes ?? null,
    correctionReason: row.correction_reason ?? null,
    actorUserId: row.actor_user_id,
    actorWorkerId: row.actor_worker_id ?? null,
    actorRole: row.actor_role as HandymanHelperAttendanceActorRole,
    idempotencyKey: row.idempotency_key,
    occurredAt: toIso(row.occurred_at),
  };
}

export interface HelperWorkerIdentityRow {
  workerContextId: string;
  userId: string | null;
  fullName: string;
  employeeCode: string;
  workforceType: string;
}

export const handymanHelperAttendanceRepository = {
  async listBaseCrewHelpers(
    executor: Executor = getPool(),
    crewId: string,
    leadWorkerId: string,
  ): Promise<HelperWorkerIdentityRow[]> {
    const res = await executor.query(
      `SELECT m.handyman_worker_context_id AS worker_context_id,
              wp.user_id,
              wp.full_name,
              wp.employee_code,
              wp.workforce_type
         FROM handyman_crew_memberships m
         JOIN handyman_worker_contexts wc
           ON wc.id = m.handyman_worker_context_id
         JOIN workforce_profiles wp
           ON wp.id = wc.workforce_profile_id
        WHERE m.handyman_crew_id = $1
          AND m.status = 'ACTIVE'
          AND m.handyman_worker_context_id <> $2
        ORDER BY m.created_at ASC, m.id ASC`,
      [crewId, leadWorkerId],
    );
    return res.rows.map((r) => ({
      workerContextId: r.worker_context_id as string,
      userId: (r.user_id as string | null) ?? null,
      fullName: r.full_name as string,
      employeeCode: r.employee_code as string,
      workforceType: r.workforce_type as string,
    }));
  },

  async findWorkerIdentitiesByIds(
    executor: Executor = getPool(),
    workerContextIds: string[],
  ): Promise<Map<string, HelperWorkerIdentityRow>> {
    const map = new Map<string, HelperWorkerIdentityRow>();
    if (workerContextIds.length === 0) return map;
    const res = await executor.query(
      `SELECT wc.id AS worker_context_id,
              wp.user_id,
              wp.full_name,
              wp.employee_code,
              wp.workforce_type
         FROM handyman_worker_contexts wc
         JOIN workforce_profiles wp
           ON wp.id = wc.workforce_profile_id
        WHERE wc.id = ANY($1::uuid[])`,
      [workerContextIds],
    );
    for (const r of res.rows) {
      map.set(r.worker_context_id as string, {
        workerContextId: r.worker_context_id as string,
        userId: (r.user_id as string | null) ?? null,
        fullName: r.full_name as string,
        employeeCode: r.employee_code as string,
        workforceType: r.workforce_type as string,
      });
    }
    return map;
  },

  async findPersonnelChangeByIdempotencyKey(
    executor: Executor,
    executionScopeId: string,
    idempotencyKey: string,
  ): Promise<HandymanScopeHelperPersonnelChangeRecord | null> {
    const res = await executor.query(
      `SELECT *
         FROM handyman_scope_helper_personnel_changes
        WHERE execution_scope_id = $1
          AND idempotency_key = $2`,
      [executionScopeId, idempotencyKey],
    );
    return res.rows[0] ? mapPersonnelChange(res.rows[0]) : null;
  },

  async insertPersonnelChange(
    executor: Executor,
    input: {
      clientId: string;
      buildingId: string;
      handymanRequestId: string;
      executionScopeId: string;
      workOrderId: string | null;
      assignmentId: string;
      crewId: string;
      workSessionId: string | null;
      changeType: HandymanHelperPersonnelChangeType;
      targetHelperWorkerId: string | null;
      targetHelperUserId: string | null;
      replacedHelperWorkerId: string | null;
      replacedHelperUserId: string | null;
      reason: string;
      authorizedByUserId: string;
      idempotencyKey: string;
    },
  ): Promise<HandymanScopeHelperPersonnelChangeRecord> {
    const res = await executor.query(
      `INSERT INTO handyman_scope_helper_personnel_changes (
         id, client_id, building_id, handyman_request_id,
         execution_scope_id, work_order_id, assignment_id, crew_id,
         work_session_id, change_type,
         target_helper_worker_id, target_helper_user_id,
         replaced_helper_worker_id, replaced_helper_user_id,
         reason, authorized_by_user_id, authorized_at, idempotency_key
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10,
         $11, $12,
         $13, $14,
         $15, $16, NOW(), $17
       )
       RETURNING *`,
      [
        randomUUID(),
        input.clientId,
        input.buildingId,
        input.handymanRequestId,
        input.executionScopeId,
        input.workOrderId,
        input.assignmentId,
        input.crewId,
        input.workSessionId,
        input.changeType,
        input.targetHelperWorkerId,
        input.targetHelperUserId,
        input.replacedHelperWorkerId,
        input.replacedHelperUserId,
        input.reason,
        input.authorizedByUserId,
        input.idempotencyKey,
      ],
    );
    return mapPersonnelChange(res.rows[0]);
  },

  async listPersonnelChangesByScopeAssignment(
    executor: Executor = getPool(),
    executionScopeId: string,
    assignmentId: string,
  ): Promise<HandymanScopeHelperPersonnelChangeRecord[]> {
    const res = await executor.query(
      `SELECT *
         FROM handyman_scope_helper_personnel_changes
        WHERE execution_scope_id = $1
          AND assignment_id = $2
        ORDER BY authorized_at ASC, created_at ASC, id ASC`,
      [executionScopeId, assignmentId],
    );
    return res.rows.map(mapPersonnelChange);
  },

  async findBoundWorkOrderIdForScope(
    executor: Executor = getPool(),
    executionScopeId: string,
  ): Promise<string | null> {
    const res = await executor.query<{ work_order_id: string }>(
      `SELECT work_order_id
         FROM (
           SELECT work_order_id, created_at
             FROM handyman_scope_helper_personnel_changes
            WHERE execution_scope_id = $1 AND work_order_id IS NOT NULL
           UNION ALL
           SELECT work_order_id, created_at
             FROM handyman_helper_attendance_confirmations
            WHERE execution_scope_id = $1 AND work_order_id IS NOT NULL
         ) bound
        ORDER BY created_at ASC
        LIMIT 1`,
      [executionScopeId],
    );
    return res.rows[0]?.work_order_id ?? null;
  },

  async findConfirmationForUpdate(
    executor: Executor,
    workSessionId: string,
    helperWorkerId: string,
  ): Promise<HandymanHelperAttendanceConfirmationRecord | null> {
    const res = await executor.query(
      `SELECT *
         FROM handyman_helper_attendance_confirmations
        WHERE work_session_id = $1
          AND helper_worker_id = $2
        FOR UPDATE`,
      [workSessionId, helperWorkerId],
    );
    return res.rows[0] ? mapConfirmation(res.rows[0]) : null;
  },

  async insertConfirmation(
    executor: Executor,
    input: {
      clientId: string;
      buildingId: string;
      handymanRequestId: string;
      executionScopeId: string;
      workOrderId: string | null;
      assignmentId: string;
      workSessionId: string;
      helperWorkerId: string;
      helperUserId: string | null;
      rosterSource: HandymanHelperRosterSource;
      personnelChangeId: string | null;
      attendanceStatus: HandymanHelperAttendanceStatus;
      confirmedByUserId: string;
      confirmedByWorkerId: string | null;
      notes: string | null;
    },
  ): Promise<HandymanHelperAttendanceConfirmationRecord> {
    const res = await executor.query(
      `INSERT INTO handyman_helper_attendance_confirmations (
         id, client_id, building_id, handyman_request_id,
         execution_scope_id, work_order_id, assignment_id,
         work_session_id, helper_worker_id, helper_user_id,
         roster_source, personnel_change_id, attendance_status,
         confirmed_by_user_id, confirmed_by_worker_id,
         first_confirmed_at, last_confirmed_at, confirmation_count,
         latest_notes, latest_correction_reason, version
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, $10,
         $11, $12, $13,
         $14, $15,
         NOW(), NOW(), 1,
         $16, NULL, 1
       )
       RETURNING *`,
      [
        randomUUID(),
        input.clientId,
        input.buildingId,
        input.handymanRequestId,
        input.executionScopeId,
        input.workOrderId,
        input.assignmentId,
        input.workSessionId,
        input.helperWorkerId,
        input.helperUserId,
        input.rosterSource,
        input.personnelChangeId,
        input.attendanceStatus,
        input.confirmedByUserId,
        input.confirmedByWorkerId,
        input.notes,
      ],
    );
    return mapConfirmation(res.rows[0]);
  },

  async updateConfirmation(
    executor: Executor,
    input: {
      id: string;
      workOrderId: string | null;
      attendanceStatus: HandymanHelperAttendanceStatus;
      confirmedByUserId: string;
      confirmedByWorkerId: string | null;
      notes: string | null;
      correctionReason: string;
    },
  ): Promise<HandymanHelperAttendanceConfirmationRecord> {
    const res = await executor.query(
      `UPDATE handyman_helper_attendance_confirmations
          SET work_order_id = COALESCE($2, work_order_id),
              attendance_status = $3,
              confirmed_by_user_id = $4,
              confirmed_by_worker_id = $5,
              last_confirmed_at = NOW(),
              confirmation_count = confirmation_count + 1,
              latest_notes = $6,
              latest_correction_reason = $7,
              version = version + 1,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [
        input.id,
        input.workOrderId,
        input.attendanceStatus,
        input.confirmedByUserId,
        input.confirmedByWorkerId,
        input.notes,
        input.correctionReason,
      ],
    );
    return mapConfirmation(res.rows[0]);
  },

  async listConfirmationsByWorkSession(
    executor: Executor = getPool(),
    workSessionId: string,
  ): Promise<HandymanHelperAttendanceConfirmationRecord[]> {
    const res = await executor.query(
      `SELECT *
         FROM handyman_helper_attendance_confirmations
        WHERE work_session_id = $1
        ORDER BY created_at ASC, id ASC`,
      [workSessionId],
    );
    return res.rows.map(mapConfirmation);
  },

  async insertEvent(
    executor: Executor,
    input: {
      confirmationId: string;
      clientId: string;
      buildingId: string;
      handymanRequestId: string;
      executionScopeId: string;
      workOrderId: string | null;
      workSessionId: string;
      helperWorkerId: string;
      helperUserId: string | null;
      eventType: HandymanHelperAttendanceEventType;
      previousStatus: HandymanHelperAttendanceStatus | null;
      newStatus: HandymanHelperAttendanceStatus;
      notes: string | null;
      correctionReason: string | null;
      actorUserId: string;
      actorWorkerId: string | null;
      actorRole: HandymanHelperAttendanceActorRole;
      idempotencyKey: string;
    },
  ): Promise<HandymanHelperAttendanceEventRecord> {
    const res = await executor.query(
      `INSERT INTO handyman_helper_attendance_events (
         id, confirmation_id, client_id, building_id,
         handyman_request_id, execution_scope_id, work_order_id,
         work_session_id, helper_worker_id, helper_user_id,
         event_type, previous_status, new_status,
         notes, correction_reason,
         actor_user_id, actor_worker_id, actor_role,
         idempotency_key, occurred_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7,
         $8, $9, $10,
         $11, $12, $13,
         $14, $15,
         $16, $17, $18,
         $19, NOW()
       )
       RETURNING *`,
      [
        randomUUID(),
        input.confirmationId,
        input.clientId,
        input.buildingId,
        input.handymanRequestId,
        input.executionScopeId,
        input.workOrderId,
        input.workSessionId,
        input.helperWorkerId,
        input.helperUserId,
        input.eventType,
        input.previousStatus,
        input.newStatus,
        input.notes,
        input.correctionReason,
        input.actorUserId,
        input.actorWorkerId,
        input.actorRole,
        input.idempotencyKey,
      ],
    );
    return mapEvent(res.rows[0]);
  },

  async listEventsBySessionAndIdempotencyKey(
    executor: Executor,
    workSessionId: string,
    idempotencyKey: string,
  ): Promise<HandymanHelperAttendanceEventRecord[]> {
    const res = await executor.query(
      `SELECT *
         FROM handyman_helper_attendance_events
        WHERE work_session_id = $1
          AND idempotency_key = $2
        ORDER BY occurred_at ASC, id ASC`,
      [workSessionId, idempotencyKey],
    );
    return res.rows.map(mapEvent);
  },

  async listEventsByWorkSession(
    executor: Executor = getPool(),
    workSessionId: string,
  ): Promise<HandymanHelperAttendanceEventRecord[]> {
    const res = await executor.query(
      `SELECT *
         FROM handyman_helper_attendance_events
        WHERE work_session_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [workSessionId],
    );
    return res.rows.map(mapEvent);
  },

  async listEventsByExecutionScope(
    executor: Executor = getPool(),
    executionScopeId: string,
  ): Promise<HandymanHelperAttendanceEventRecord[]> {
    const res = await executor.query(
      `SELECT *
         FROM handyman_helper_attendance_events
        WHERE execution_scope_id = $1
        ORDER BY occurred_at ASC, id ASC`,
      [executionScopeId],
    );
    return res.rows.map(mapEvent);
  },

  async listUnverifiedPresenceHelperWorkerIds(
    executor: Executor = getPool(),
    workSessionId: string,
  ): Promise<Set<string>> {
    const res = await executor.query<{ helper_worker_id: string }>(
      `SELECT DISTINCT helper_worker_id
         FROM handyman_work_session_helper_presence
        WHERE session_id = $1`,
      [workSessionId],
    );
    return new Set(res.rows.map((r) => r.helper_worker_id));
  },
};

export { toNullableIso };

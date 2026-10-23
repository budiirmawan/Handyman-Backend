import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access/context-access.service';
import { permissionService } from '../permissions';
import { recordOperationalEvent } from '../operational-events';
import {
  handymanScopeAssignmentRepository,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';
import { findEligibleHandymanWorker } from '../handyman-providers/handyman-worker-eligibility.repository';
import {
  handymanHelperAttendanceRepository,
  type HelperWorkerIdentityRow,
} from './handyman-helper-attendance.repository';
import {
  HANDYMAN_HELPER_ATTENDANCE_STATUSES,
  HANDYMAN_HELPER_PERSONNEL_CHANGE_TYPES,
  type HandymanHelperAttendanceConfirmationRecord,
  type HandymanHelperAttendanceProjection,
  type HandymanHelperAttendanceStatus,
  type HandymanHelperPersonnelChangeType,
  type HandymanHelperRosterMemberProjection,
  type HandymanHelperRosterSource,
  type HandymanScopeHelperPersonnelChangeRecord,
} from './handyman-helper-attendance.types';

function assertPlainObject(
  raw: unknown,
  label = 'Request body',
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw AppError.validation(`${label} must be a JSON object.`);
  }
  return raw as Record<string, unknown>;
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  label = 'Request body',
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(obj).filter((k) => !allowedSet.has(k));
  if (unknown.length > 0) {
    throw AppError.validation(
      `${label} contains unknown fields: ${unknown.join(', ')}.`,
    );
  }
}

function assertUuid(raw: unknown, field: string): string {
  const val = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!isValidUuid(val)) {
    throw AppError.validation(`${field} must be a valid UUID.`);
  }
  return val;
}

function assertIdempotencyKey(raw: unknown): string {
  const val = typeof raw === 'string' ? raw.trim() : '';
  if (val.length === 0 || val.length > 200) {
    throw AppError.validation(
      'idempotencyKey must be a non-empty string up to 200 characters.',
    );
  }
  return val;
}

function parseOptionalText(
  raw: unknown,
  field: string,
  maxLength = 1000,
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw AppError.validation(`${field} must be a string when supplied.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw AppError.validation(
      `${field} must not exceed ${maxLength} characters.`,
    );
  }
  return trimmed;
}

function parseRequiredReason(raw: unknown, field: string): string {
  if (typeof raw !== 'string') {
    throw AppError.validation(`${field} is required.`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 1000) {
    throw AppError.validation(
      `${field} must be a non-empty string up to 1000 characters.`,
    );
  }
  return trimmed;
}

interface ScopeContext {
  executionScopeId: string;
  clientId: string;
  handymanRequestId: string;
  buildingId: string;
  status: string;
}

async function loadScopeContext(
  executionScopeId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<ScopeContext> {
  const validScopeId = assertUuid(executionScopeId, 'executionScopeId');
  const res = await executor.query<{
    id: string;
    client_id: string;
    handyman_request_id: string;
    building_id: string;
    status: string;
  }>(
    `SELECT id, client_id, handyman_request_id, building_id, status
       FROM handyman_execution_scopes
      WHERE id = $1`,
    [validScopeId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.HANDYMAN_EXECUTION_SCOPE_NOT_FOUND,
      message: 'Handyman execution scope not found.',
    });
  }
  return {
    executionScopeId: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    buildingId: row.building_id,
    status: row.status,
  };
}

async function assertBuildingScopeAccess(
  actorUserId: string,
  ctx: ScopeContext,
): Promise<void> {
  const allowed = await contextAccessService.canAccessBuildingScopedResource(
    actorUserId,
    {
      clientId: ctx.clientId,
      buildingId: ctx.buildingId,
    },
  );
  if (!allowed) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.BUILDING_ACCESS_DENIED,
      message: 'Access to the requested building context is denied.',
    });
  }
}

async function assertOperationsPermission(
  actorUserId: string,
  requiredPermission: 'tenant_company.read' | 'tenant_company.manage',
): Promise<void> {
  const permissions =
    await permissionService.resolvePermissionsForUser(actorUserId);
  if (!permissions.includes(requiredPermission)) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_HELPER_ATTENDANCE_FORBIDDEN,
      message: `Actor lacks required Operations permission (${requiredPermission}).`,
    });
  }
}

async function resolveAndValidateWorkOrderId(
  executor: Pick<PoolClient, 'query'>,
  ctx: ScopeContext,
  rawWorkOrderId: unknown,
): Promise<string | null> {
  const existingBoundWoId =
    await handymanHelperAttendanceRepository.findBoundWorkOrderIdForScope(
      executor,
      ctx.executionScopeId,
    );

  if (rawWorkOrderId === undefined || rawWorkOrderId === null) {
    return existingBoundWoId;
  }

  const validWoId = assertUuid(rawWorkOrderId, 'workOrderId');
  if (existingBoundWoId && existingBoundWoId !== validWoId) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_HELPER_CROSS_WORK_ORDER_MISMATCH,
      message:
        'Execution Scope helper attendance is already bound to a different Work Order.',
    });
  }

  const woRes = await executor.query<{
    id: string;
    client_id: string;
    building_id: string;
  }>(
    `SELECT id, client_id, building_id
       FROM work_orders
      WHERE id = $1`,
    [validWoId],
  );
  const wo = woRes.rows[0];
  if (!wo) {
    throw new AppError({
      statusCode: 404,
      code: ERROR_CODES.WORK_ORDER_NOT_FOUND,
      message: 'Referenced Work Order not found.',
    });
  }
  if (wo.client_id !== ctx.clientId || wo.building_id !== ctx.buildingId) {
    throw new AppError({
      statusCode: 409,
      code: ERROR_CODES.HANDYMAN_HELPER_CROSS_WORK_ORDER_MISMATCH,
      message:
        'Referenced workOrderId does not belong to the exact Client and Building of this Execution Scope.',
    });
  }
  return wo.id;
}

interface EffectiveRosterItemState {
  helperWorkerId: string;
  helperUserId: string | null;
  fullName: string;
  employeeCode: string;
  workforceType: string;
  rosterSource: HandymanHelperRosterSource;
  personnelChangeId: string | null;
  replacesHelperWorkerId: string | null;
  replacedByHelperWorkerId: string | null;
  activeInRoster: boolean;
}

async function computeEffectiveRosterMap(
  executor: Pick<PoolClient, 'query'>,
  input: {
    executionScopeId: string;
    assignmentId: string;
    crewId: string;
    leadWorkerId: string;
  },
): Promise<{
  rosterMap: Map<string, EffectiveRosterItemState>;
  personnelChanges: HandymanScopeHelperPersonnelChangeRecord[];
}> {
  const baseHelpers =
    await handymanHelperAttendanceRepository.listBaseCrewHelpers(
      executor,
      input.crewId,
      input.leadWorkerId,
    );
  const personnelChanges =
    await handymanHelperAttendanceRepository.listPersonnelChangesByScopeAssignment(
      executor,
      input.executionScopeId,
      input.assignmentId,
    );

  const extraWorkerIds = new Set<string>();
  for (const ch of personnelChanges) {
    if (ch.targetHelperWorkerId) extraWorkerIds.add(ch.targetHelperWorkerId);
    if (ch.replacedHelperWorkerId) {
      extraWorkerIds.add(ch.replacedHelperWorkerId);
    }
  }
  const identityMap = new Map<string, HelperWorkerIdentityRow>();
  for (const b of baseHelpers) identityMap.set(b.workerContextId, b);
  if (extraWorkerIds.size > 0) {
    const fetched =
      await handymanHelperAttendanceRepository.findWorkerIdentitiesByIds(
        executor,
        [...extraWorkerIds],
      );
    for (const [k, v] of fetched.entries()) identityMap.set(k, v);
  }

  const rosterMap = new Map<string, EffectiveRosterItemState>();
  for (const base of baseHelpers) {
    rosterMap.set(base.workerContextId, {
      helperWorkerId: base.workerContextId,
      helperUserId: base.userId,
      fullName: base.fullName,
      employeeCode: base.employeeCode,
      workforceType: base.workforceType,
      rosterSource: 'CREW_ROSTER',
      personnelChangeId: null,
      replacesHelperWorkerId: null,
      replacedByHelperWorkerId: null,
      activeInRoster: true,
    });
  }

  for (const ch of personnelChanges) {
    if (ch.changeType === 'ADD_HELPER' && ch.targetHelperWorkerId) {
      const idRow = identityMap.get(ch.targetHelperWorkerId);
      if (idRow) {
        rosterMap.set(ch.targetHelperWorkerId, {
          helperWorkerId: idRow.workerContextId,
          helperUserId: idRow.userId,
          fullName: idRow.fullName,
          employeeCode: idRow.employeeCode,
          workforceType: idRow.workforceType,
          rosterSource: 'OPERATIONS_ADDITION',
          personnelChangeId: ch.id,
          replacesHelperWorkerId: null,
          replacedByHelperWorkerId: null,
          activeInRoster: true,
        });
      }
    } else if (
      ch.changeType === 'REMOVE_HELPER' &&
      ch.replacedHelperWorkerId
    ) {
      const existing = rosterMap.get(ch.replacedHelperWorkerId);
      if (existing) {
        existing.activeInRoster = false;
        existing.replacedByHelperWorkerId = null;
      }
    } else if (
      ch.changeType === 'SUBSTITUTE_HELPER' &&
      ch.replacedHelperWorkerId &&
      ch.targetHelperWorkerId
    ) {
      const replaced = rosterMap.get(ch.replacedHelperWorkerId);
      if (replaced) {
        replaced.activeInRoster = false;
        replaced.replacedByHelperWorkerId = ch.targetHelperWorkerId;
      }
      const targetRow = identityMap.get(ch.targetHelperWorkerId);
      if (targetRow) {
        rosterMap.set(ch.targetHelperWorkerId, {
          helperWorkerId: targetRow.workerContextId,
          helperUserId: targetRow.userId,
          fullName: targetRow.fullName,
          employeeCode: targetRow.employeeCode,
          workforceType: targetRow.workforceType,
          rosterSource: 'OPERATIONS_SUBSTITUTION',
          personnelChangeId: ch.id,
          replacesHelperWorkerId: ch.replacedHelperWorkerId,
          replacedByHelperWorkerId: null,
          activeInRoster: true,
        });
      }
    }
  }

  return { rosterMap, personnelChanges };
}

async function resolveSessionForProjection(
  executor: Pick<PoolClient, 'query'>,
  executionScopeId: string,
  requestedSessionId: string | null,
): Promise<{ id: string; status: string } | null> {
  if (requestedSessionId) {
    const res = await executor.query<{
      id: string;
      status: string;
      execution_scope_id: string;
    }>(
      `SELECT id, status, execution_scope_id
         FROM handyman_work_sessions
        WHERE id = $1`,
      [requestedSessionId],
    );
    const row = res.rows[0];
    if (!row || row.execution_scope_id !== executionScopeId) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_HELPER_ATTENDANCE_SESSION_REQUIRED,
        message:
          'Requested workSessionId does not belong to this Execution Scope.',
      });
    }
    return { id: row.id, status: row.status };
  }

  const activeRes = await executor.query<{ id: string; status: string }>(
    `SELECT id, status
       FROM handyman_work_sessions
      WHERE execution_scope_id = $1
        AND status <> 'CHECKED_OUT'
      ORDER BY created_at DESC
      LIMIT 1`,
    [executionScopeId],
  );
  if (activeRes.rows[0]) return activeRes.rows[0];

  const latestRes = await executor.query<{ id: string; status: string }>(
    `SELECT id, status
       FROM handyman_work_sessions
      WHERE execution_scope_id = $1
      ORDER BY created_at DESC
      LIMIT 1`,
    [executionScopeId],
  );
  return latestRes.rows[0] ?? null;
}

async function resolveCurrentLeadForCrew(
  executor: Pick<PoolClient, 'query'>,
  crewId: string,
  clientId: string,
): Promise<{ leadWorkerId: string; leadUserId: string | null } | null> {
  const res = await executor.query<{
    worker_id: string;
    user_id: string | null;
  }>(
    `SELECT cm.handyman_worker_context_id AS worker_id,
            wp.user_id AS user_id
       FROM handyman_crew_leads cl
       JOIN handyman_crew_memberships cm
         ON cm.id = cl.handyman_crew_membership_id
       JOIN handyman_worker_contexts wc
         ON wc.id = cm.handyman_worker_context_id
       JOIN workforce_profiles wp
         ON wp.id = wc.workforce_profile_id
      WHERE cl.handyman_crew_id = $1
        AND cl.client_id = $2
      ORDER BY cl.lead_seq DESC
      LIMIT 1`,
    [crewId, clientId],
  );
  if (!res.rows[0]) return null;
  return {
    leadWorkerId: res.rows[0].worker_id,
    leadUserId: res.rows[0].user_id ?? null,
  };
}

async function buildProjection(
  executor: Pick<PoolClient, 'query'>,
  ctx: ScopeContext,
  requestedSessionId: string | null = null,
): Promise<HandymanHelperAttendanceProjection> {
  const activeAssignment =
    await handymanScopeAssignmentRepository.findActiveAssignmentByScope(
      executor,
      ctx.executionScopeId,
    );
  const session = await resolveSessionForProjection(
    executor,
    ctx.executionScopeId,
    requestedSessionId,
  );
  const boundWorkOrderId =
    await handymanHelperAttendanceRepository.findBoundWorkOrderIdForScope(
      executor,
      ctx.executionScopeId,
    );

  if (!activeAssignment) {
    return {
      executionScopeId: ctx.executionScopeId,
      handymanRequestId: ctx.handymanRequestId,
      workOrderId: boundWorkOrderId,
      buildingId: ctx.buildingId,
      assignmentId: null,
      crewId: null,
      leadWorkerId: null,
      leadUserId: null,
      workSessionId: session?.id ?? null,
      workSessionStatus: session?.status ?? null,
      roster: [],
      removedHelpers: [],
      personnelChanges: [],
      history: [],
      summary: {
        totalEffectiveHelpers: 0,
        loginlessHelperCount: 0,
        unverifiedPresenceSnapshotCount: 0,
        confirmedPresentCount: 0,
        confirmedAbsentCount: 0,
        unconfirmedCount: 0,
        allHelpersConfirmed: true,
        presenceSnapshotIsVerifiedProof: false,
        feeApprovalAutomatic: false,
      },
    };
  }

  const leadInfo = await resolveCurrentLeadForCrew(
    executor,
    activeAssignment.handymanCrewId,
    ctx.clientId,
  );
  const leadWorkerId =
    leadInfo?.leadWorkerId ?? '00000000-0000-0000-0000-000000000000';

  const { rosterMap, personnelChanges } = await computeEffectiveRosterMap(
    executor,
    {
      executionScopeId: ctx.executionScopeId,
      assignmentId: activeAssignment.id,
      crewId: activeAssignment.handymanCrewId,
      leadWorkerId,
    },
  );

  const confirmationsByHelper = new Map<
    string,
    HandymanHelperAttendanceConfirmationRecord
  >();
  let unverifiedPresenceSet = new Set<string>();
  const history = session
    ? await handymanHelperAttendanceRepository.listEventsByWorkSession(
        executor,
        session.id,
      )
    : await handymanHelperAttendanceRepository.listEventsByExecutionScope(
        executor,
        ctx.executionScopeId,
      );

  if (session) {
    const [confirmations, presenceSet] = await Promise.all([
      handymanHelperAttendanceRepository.listConfirmationsByWorkSession(
        executor,
        session.id,
      ),
      handymanHelperAttendanceRepository.listUnverifiedPresenceHelperWorkerIds(
        executor,
        session.id,
      ),
    ]);
    for (const c of confirmations) {
      confirmationsByHelper.set(c.helperWorkerId, c);
    }
    unverifiedPresenceSet = presenceSet;
  }

  const roster: HandymanHelperRosterMemberProjection[] = [];
  const removedHelpers: HandymanHelperRosterMemberProjection[] = [];

  for (const entry of rosterMap.values()) {
    const conf = confirmationsByHelper.get(entry.helperWorkerId) ?? null;
    // CRITICAL INVARIANT (PART 02 §6):
    // Roster membership or `handyman_work_session_helper_presence` snapshot
    // NEVER sets `attendanceVerified = true` or `attendanceStatus = 'HADIR'`.
    // Only an explicit confirmation record produces verified attendance.
    const item: HandymanHelperRosterMemberProjection = {
      helperWorkerId: entry.helperWorkerId,
      helperUserId: entry.helperUserId,
      hasMobileAccount: entry.helperUserId !== null,
      fullName: entry.fullName,
      employeeCode: entry.employeeCode,
      workforceType: entry.workforceType,
      rosterSource: entry.rosterSource,
      personnelChangeId: entry.personnelChangeId,
      replacesHelperWorkerId: entry.replacesHelperWorkerId,
      replacedByHelperWorkerId: entry.replacedByHelperWorkerId,
      activeInRoster: entry.activeInRoster,
      unverifiedPresenceSnapshotRecorded: unverifiedPresenceSet.has(
        entry.helperWorkerId,
      ),
      attendanceStatus: conf ? conf.attendanceStatus : 'UNCONFIRMED',
      attendanceVerified: conf !== null,
      confirmedByUserId: conf ? conf.confirmedByUserId : null,
      confirmedByWorkerId: conf ? conf.confirmedByWorkerId : null,
      firstConfirmedAt: conf ? conf.firstConfirmedAt : null,
      lastConfirmedAt: conf ? conf.lastConfirmedAt : null,
      confirmationCount: conf ? conf.confirmationCount : 0,
      latestNotes: conf ? conf.latestNotes : null,
      latestCorrectionReason: conf ? conf.latestCorrectionReason : null,
    };
    if (entry.activeInRoster) {
      roster.push(item);
    } else {
      removedHelpers.push(item);
    }
  }

  const confirmedPresentCount = roster.filter(
    (r) => r.attendanceVerified && r.attendanceStatus === 'HADIR',
  ).length;
  const confirmedAbsentCount = roster.filter(
    (r) => r.attendanceVerified && r.attendanceStatus === 'TIDAK_HADIR',
  ).length;
  const unconfirmedCount = roster.filter((r) => !r.attendanceVerified).length;
  const loginlessHelperCount = roster.filter((r) => !r.hasMobileAccount).length;

  return {
    executionScopeId: ctx.executionScopeId,
    handymanRequestId: ctx.handymanRequestId,
    workOrderId: boundWorkOrderId,
    buildingId: ctx.buildingId,
    assignmentId: activeAssignment.id,
    crewId: activeAssignment.handymanCrewId,
    leadWorkerId: leadInfo?.leadWorkerId ?? null,
    leadUserId: leadInfo?.leadUserId ?? null,
    workSessionId: session?.id ?? null,
    workSessionStatus: session?.status ?? null,
    roster,
    removedHelpers,
    personnelChanges,
    history,
    summary: {
      totalEffectiveHelpers: roster.length,
      loginlessHelperCount,
      unverifiedPresenceSnapshotCount: unverifiedPresenceSet.size,
      confirmedPresentCount,
      confirmedAbsentCount,
      unconfirmedCount,
      allHelpersConfirmed: unconfirmedCount === 0,
      presenceSnapshotIsVerifiedProof: false,
      feeApprovalAutomatic: false,
    },
  };
}

function parseOptionalWorkSessionQuery(rawQuery: unknown): string | null {
  if (rawQuery === undefined || rawQuery === null) return null;
  const query = assertPlainObject(rawQuery, 'Query parameters');
  assertAllowedKeys(query, ['workSessionId'], 'Query parameters');
  if (query.workSessionId === undefined || query.workSessionId === '') {
    return null;
  }
  return assertUuid(query.workSessionId, 'workSessionId');
}

export async function getFieldHelperAttendance(
  actorUserId: string,
  executionScopeId: string,
  rawQuery?: unknown,
): Promise<HandymanHelperAttendanceProjection> {
  const validActorId = assertUuid(actorUserId, 'actorUserId');
  const requestedSessionId = parseOptionalWorkSessionQuery(rawQuery);
  const ctx = await loadScopeContext(executionScopeId);
  await assertBuildingScopeAccess(validActorId, ctx);

  const resolution = await resolveHandymanAssignmentLead(
    ctx.executionScopeId,
    validActorId,
  );
  if (!resolution || resolution.leadUserId !== validActorId) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_HELPER_ATTENDANCE_FORBIDDEN,
      message:
        'Only the current authoritative assigned Crew Lead may access field helper attendance confirmation.',
    });
  }

  return buildProjection(getPool(), ctx, requestedSessionId);
}

export async function getOperationsHelperAttendance(
  actorUserId: string,
  executionScopeId: string,
  rawQuery?: unknown,
): Promise<HandymanHelperAttendanceProjection> {
  const validActorId = assertUuid(actorUserId, 'actorUserId');
  const requestedSessionId = parseOptionalWorkSessionQuery(rawQuery);
  const ctx = await loadScopeContext(executionScopeId);
  await assertOperationsPermission(validActorId, 'tenant_company.read');
  await assertBuildingScopeAccess(validActorId, ctx);

  return buildProjection(getPool(), ctx, requestedSessionId);
}

export async function confirmFieldHelperAttendance(
  actorUserId: string,
  executionScopeId: string,
  rawBody: unknown,
): Promise<HandymanHelperAttendanceProjection & { replayed: boolean }> {
  const validActorId = assertUuid(actorUserId, 'actorUserId');
  const body = assertPlainObject(rawBody);
  assertAllowedKeys(body, [
    'workOrderId',
    'workSessionId',
    'confirmations',
    'idempotencyKey',
  ]);

  const idempotencyKey = assertIdempotencyKey(body.idempotencyKey);
  const requestedWorkSessionId =
    body.workSessionId !== undefined && body.workSessionId !== null
      ? assertUuid(body.workSessionId, 'workSessionId')
      : null;

  if (!Array.isArray(body.confirmations) || body.confirmations.length === 0) {
    throw AppError.validation(
      'confirmations must be a non-empty array of helper attendance items.',
    );
  }
  if (body.confirmations.length > 50) {
    throw AppError.validation(
      'confirmations must not exceed 50 items per request.',
    );
  }

  const parsedItems: Array<{
    helperWorkerId: string;
    attendanceStatus: HandymanHelperAttendanceStatus;
    notes: string | null;
    correctionReason: string | null;
  }> = [];
  const seenHelperIds = new Set<string>();

  for (let i = 0; i < body.confirmations.length; i += 1) {
    const itemObj = assertPlainObject(
      body.confirmations[i],
      `confirmations[${i}]`,
    );
    assertAllowedKeys(
      itemObj,
      ['helperWorkerId', 'attendanceStatus', 'notes', 'correctionReason'],
      `confirmations[${i}]`,
    );
    const helperWorkerId = assertUuid(
      itemObj.helperWorkerId,
      `confirmations[${i}].helperWorkerId`,
    );
    if (seenHelperIds.has(helperWorkerId)) {
      throw AppError.validation(
        `Duplicate helperWorkerId (${helperWorkerId}) in confirmations payload.`,
      );
    }
    seenHelperIds.add(helperWorkerId);

    const statusRaw =
      typeof itemObj.attendanceStatus === 'string'
        ? itemObj.attendanceStatus.trim()
        : '';
    if (
      !(HANDYMAN_HELPER_ATTENDANCE_STATUSES as readonly string[]).includes(
        statusRaw,
      )
    ) {
      throw AppError.validation(
        `confirmations[${i}].attendanceStatus must be one of: ${HANDYMAN_HELPER_ATTENDANCE_STATUSES.join(', ')}.`,
      );
    }
    const notes = parseOptionalText(
      itemObj.notes,
      `confirmations[${i}].notes`,
      1000,
    );
    const correctionReason = parseOptionalText(
      itemObj.correctionReason,
      `confirmations[${i}].correctionReason`,
      1000,
    );
    parsedItems.push({
      helperWorkerId,
      attendanceStatus: statusRaw as HandymanHelperAttendanceStatus,
      notes,
      correctionReason,
    });
  }

  const ctx = await loadScopeContext(executionScopeId);
  await assertBuildingScopeAccess(validActorId, ctx);

  const resolution = await resolveHandymanAssignmentLead(
    ctx.executionScopeId,
    validActorId,
  );
  if (!resolution || resolution.leadUserId !== validActorId) {
    throw new AppError({
      statusCode: 403,
      code: ERROR_CODES.HANDYMAN_HELPER_ATTENDANCE_FORBIDDEN,
      message:
        'Only the current authoritative assigned Crew Lead may confirm actual helper attendance.',
    });
  }

  return withTransaction(async (tx) => {
    const sessionRes = await tx.query<{
      id: string;
      status: string;
      assignment_id: string;
    }>(
      `SELECT id, status, assignment_id
         FROM handyman_work_sessions
        WHERE execution_scope_id = $1
          AND status <> 'CHECKED_OUT'
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [ctx.executionScopeId],
    );
    const activeSession = sessionRes.rows[0];
    if (!activeSession) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_HELPER_ATTENDANCE_SESSION_REQUIRED,
        message:
          'An active (non-CHECKED_OUT) Work Session is required before confirming actual helper attendance.',
      });
    }
    if (
      requestedWorkSessionId &&
      requestedWorkSessionId !== activeSession.id
    ) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_HELPER_ATTENDANCE_SESSION_REQUIRED,
        message:
          'workSessionId does not match the current active Work Session on this Execution Scope.',
      });
    }

    const workOrderId = await resolveAndValidateWorkOrderId(
      tx,
      ctx,
      body.workOrderId,
    );

    const existingEvents =
      await handymanHelperAttendanceRepository.listEventsBySessionAndIdempotencyKey(
        tx,
        activeSession.id,
        idempotencyKey,
      );
    if (existingEvents.length > 0) {
      const eventMap = new Map(
        existingEvents.map((e) => [e.helperWorkerId, e.newStatus]),
      );
      const exactMatch =
        existingEvents.length === parsedItems.length &&
        parsedItems.every(
          (item) => eventMap.get(item.helperWorkerId) === item.attendanceStatus,
        );
      if (!exactMatch) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.CONFLICT,
          message:
            'idempotencyKey was already used with a different helper attendance payload on this Work Session.',
        });
      }
      const projection = await buildProjection(tx, ctx, activeSession.id);
      return { ...projection, replayed: true };
    }

    const { rosterMap } = await computeEffectiveRosterMap(tx, {
      executionScopeId: ctx.executionScopeId,
      assignmentId: resolution.assignmentId,
      crewId: resolution.crewId,
      leadWorkerId: resolution.leadWorkerContextId,
    });

    for (const item of parsedItems) {
      if (item.helperWorkerId === resolution.leadWorkerContextId) {
        throw new AppError({
          statusCode: 422,
          code: ERROR_CODES.HANDYMAN_HELPER_ATTENDANCE_NOT_IN_ROSTER,
          message:
            'Crew Lead attendance is governed by Lead Check-In, not Helper attendance confirmation.',
        });
      }
      const rosterEntry = rosterMap.get(item.helperWorkerId);
      if (!rosterEntry || !rosterEntry.activeInRoster) {
        throw new AppError({
          statusCode: 422,
          code: ERROR_CODES.HANDYMAN_HELPER_ATTENDANCE_NOT_IN_ROSTER,
          message: `Helper (${item.helperWorkerId}) is not in the effective authorized Helper roster for this Execution Scope. Personnel changes require Operations authorization.`,
        });
      }

      const existingConf =
        await handymanHelperAttendanceRepository.findConfirmationForUpdate(
          tx,
          activeSession.id,
          item.helperWorkerId,
        );

      if (!existingConf) {
        const created =
          await handymanHelperAttendanceRepository.insertConfirmation(tx, {
            clientId: ctx.clientId,
            buildingId: ctx.buildingId,
            handymanRequestId: ctx.handymanRequestId,
            executionScopeId: ctx.executionScopeId,
            workOrderId,
            assignmentId: resolution.assignmentId,
            workSessionId: activeSession.id,
            helperWorkerId: item.helperWorkerId,
            helperUserId: rosterEntry.helperUserId,
            rosterSource: rosterEntry.rosterSource,
            personnelChangeId: rosterEntry.personnelChangeId,
            attendanceStatus: item.attendanceStatus,
            confirmedByUserId: validActorId,
            confirmedByWorkerId: resolution.leadWorkerContextId,
            notes: item.notes,
          });

        await handymanHelperAttendanceRepository.insertEvent(tx, {
          confirmationId: created.id,
          clientId: ctx.clientId,
          buildingId: ctx.buildingId,
          handymanRequestId: ctx.handymanRequestId,
          executionScopeId: ctx.executionScopeId,
          workOrderId: created.workOrderId,
          workSessionId: activeSession.id,
          helperWorkerId: item.helperWorkerId,
          helperUserId: rosterEntry.helperUserId,
          eventType: 'INITIAL_CONFIRMATION',
          previousStatus: null,
          newStatus: item.attendanceStatus,
          notes: item.notes,
          correctionReason: null,
          actorUserId: validActorId,
          actorWorkerId: resolution.leadWorkerContextId,
          actorRole: 'CREW_LEAD',
          idempotencyKey,
        });
      } else {
        if (!item.correctionReason) {
          throw new AppError({
            statusCode: 422,
            code: ERROR_CODES.HANDYMAN_HELPER_ATTENDANCE_CORRECTION_REASON_REQUIRED,
            message:
              'correctionReason is required when modifying an already-confirmed Helper attendance status.',
          });
        }
        const updated =
          await handymanHelperAttendanceRepository.updateConfirmation(tx, {
            id: existingConf.id,
            workOrderId,
            attendanceStatus: item.attendanceStatus,
            confirmedByUserId: validActorId,
            confirmedByWorkerId: resolution.leadWorkerContextId,
            notes: item.notes,
            correctionReason: item.correctionReason,
          });

        await handymanHelperAttendanceRepository.insertEvent(tx, {
          confirmationId: updated.id,
          clientId: ctx.clientId,
          buildingId: ctx.buildingId,
          handymanRequestId: ctx.handymanRequestId,
          executionScopeId: ctx.executionScopeId,
          workOrderId: updated.workOrderId,
          workSessionId: activeSession.id,
          helperWorkerId: item.helperWorkerId,
          helperUserId: rosterEntry.helperUserId,
          eventType: 'STATUS_CORRECTION',
          previousStatus: existingConf.attendanceStatus,
          newStatus: item.attendanceStatus,
          notes: item.notes,
          correctionReason: item.correctionReason,
          actorUserId: validActorId,
          actorWorkerId: resolution.leadWorkerContextId,
          actorRole: 'CREW_LEAD',
          idempotencyKey,
        });
      }
    }

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId: validActorId,
        eventType: 'handyman_helper_attendance.confirmed',
        entityType: 'handyman_execution_scope',
        entityId: ctx.executionScopeId,
        summary: `Confirmed actual attendance for ${parsedItems.length} helper(s) on session ${activeSession.id}.`,
        metadata: {
          executionScopeId: ctx.executionScopeId,
          workSessionId: activeSession.id,
          workOrderId,
          helperCount: parsedItems.length,
        },
      },
      tx,
    );

    // NON-COUPLING INVARIANT (PART 02 §7):
    // Zero automatic fee approval, entitlement creation, or commercial mutation.
    const projection = await buildProjection(tx, ctx, activeSession.id);
    return { ...projection, replayed: false };
  });
}

export async function authorizeScopeHelperPersonnelChange(
  actorUserId: string,
  executionScopeId: string,
  rawBody: unknown,
): Promise<{
  personnelChange: HandymanScopeHelperPersonnelChangeRecord;
  projection: HandymanHelperAttendanceProjection;
  replayed: boolean;
}> {
  const validActorId = assertUuid(actorUserId, 'actorUserId');
  const body = assertPlainObject(rawBody);
  assertAllowedKeys(body, [
    'workOrderId',
    'changeType',
    'targetHelperWorkerId',
    'replacedHelperWorkerId',
    'reason',
    'idempotencyKey',
  ]);

  const changeTypeRaw =
    typeof body.changeType === 'string' ? body.changeType.trim() : '';
  if (
    !(HANDYMAN_HELPER_PERSONNEL_CHANGE_TYPES as readonly string[]).includes(
      changeTypeRaw,
    )
  ) {
    throw AppError.validation(
      `changeType must be one of: ${HANDYMAN_HELPER_PERSONNEL_CHANGE_TYPES.join(', ')}.`,
    );
  }
  const changeType = changeTypeRaw as HandymanHelperPersonnelChangeType;
  const reason = parseRequiredReason(body.reason, 'reason');
  const idempotencyKey = assertIdempotencyKey(body.idempotencyKey);

  const targetHelperWorkerId =
    body.targetHelperWorkerId !== undefined &&
    body.targetHelperWorkerId !== null
      ? assertUuid(body.targetHelperWorkerId, 'targetHelperWorkerId')
      : null;
  const replacedHelperWorkerId =
    body.replacedHelperWorkerId !== undefined &&
    body.replacedHelperWorkerId !== null
      ? assertUuid(body.replacedHelperWorkerId, 'replacedHelperWorkerId')
      : null;

  if (changeType === 'ADD_HELPER') {
    if (!targetHelperWorkerId || replacedHelperWorkerId !== null) {
      throw AppError.validation(
        'ADD_HELPER requires targetHelperWorkerId and forbids replacedHelperWorkerId.',
      );
    }
  } else if (changeType === 'REMOVE_HELPER') {
    if (!replacedHelperWorkerId || targetHelperWorkerId !== null) {
      throw AppError.validation(
        'REMOVE_HELPER requires replacedHelperWorkerId and forbids targetHelperWorkerId.',
      );
    }
  } else if (changeType === 'SUBSTITUTE_HELPER') {
    if (!targetHelperWorkerId || !replacedHelperWorkerId) {
      throw AppError.validation(
        'SUBSTITUTE_HELPER requires both targetHelperWorkerId and replacedHelperWorkerId.',
      );
    }
    if (targetHelperWorkerId === replacedHelperWorkerId) {
      throw AppError.validation(
        'targetHelperWorkerId and replacedHelperWorkerId must be distinct.',
      );
    }
  }

  const ctx = await loadScopeContext(executionScopeId);
  await assertOperationsPermission(validActorId, 'tenant_company.manage');
  await assertBuildingScopeAccess(validActorId, ctx);

  return withTransaction(async (tx) => {
    await tx.query(
      `SELECT id FROM handyman_execution_scopes WHERE id = $1 FOR UPDATE`,
      [ctx.executionScopeId],
    );

    const existingChange =
      await handymanHelperAttendanceRepository.findPersonnelChangeByIdempotencyKey(
        tx,
        ctx.executionScopeId,
        idempotencyKey,
      );
    if (existingChange) {
      if (
        existingChange.changeType !== changeType ||
        existingChange.targetHelperWorkerId !== targetHelperWorkerId ||
        existingChange.replacedHelperWorkerId !== replacedHelperWorkerId
      ) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.CONFLICT,
          message:
            'idempotencyKey was already used with a different helper personnel change payload on this Execution Scope.',
        });
      }
      const projection = await buildProjection(tx, ctx, null);
      return {
        personnelChange: existingChange,
        projection,
        replayed: true,
      };
    }

    const activeAssignment =
      await handymanScopeAssignmentRepository.findActiveAssignmentByScope(
        tx,
        ctx.executionScopeId,
      );
    if (!activeAssignment) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_HELPER_ROSTER_CHANGE_CONFLICT,
        message:
          'An active Crew assignment is required on the Execution Scope before authorizing helper personnel changes.',
      });
    }

    const workOrderId = await resolveAndValidateWorkOrderId(
      tx,
      ctx,
      body.workOrderId,
    );

    const leadInfo = await resolveCurrentLeadForCrew(
      tx,
      activeAssignment.handymanCrewId,
      ctx.clientId,
    );
    if (!leadInfo) {
      throw new AppError({
        statusCode: 409,
        code: ERROR_CODES.HANDYMAN_HELPER_ROSTER_CHANGE_CONFLICT,
        message: 'Assigned Crew does not have a valid designated Crew Lead.',
      });
    }

    const { rosterMap } = await computeEffectiveRosterMap(tx, {
      executionScopeId: ctx.executionScopeId,
      assignmentId: activeAssignment.id,
      crewId: activeAssignment.handymanCrewId,
      leadWorkerId: leadInfo.leadWorkerId,
    });

    let targetHelperUserId: string | null = null;
    let replacedHelperUserId: string | null = null;

    if (replacedHelperWorkerId) {
      const replacedEntry = rosterMap.get(replacedHelperWorkerId);
      if (!replacedEntry || !replacedEntry.activeInRoster) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_HELPER_ROSTER_CHANGE_CONFLICT,
          message: `Helper (${replacedHelperWorkerId}) is not currently active in the effective Helper roster for this Execution Scope.`,
        });
      }
      replacedHelperUserId = replacedEntry.helperUserId;
    }

    if (targetHelperWorkerId) {
      if (targetHelperWorkerId === leadInfo.leadWorkerId) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_HELPER_ROSTER_CHANGE_CONFLICT,
          message:
            'Crew Lead cannot be added or substituted as a Helper on the same Execution Scope.',
        });
      }
      const existingTarget = rosterMap.get(targetHelperWorkerId);
      if (existingTarget && existingTarget.activeInRoster) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_HELPER_ROSTER_CHANGE_CONFLICT,
          message: `Helper (${targetHelperWorkerId}) is already active in the effective Helper roster for this Execution Scope.`,
        });
      }

      // Preserve login-less Helpers (`requireLogin: false`): validates active
      // worker context, Client/provider match, and exact-Building placement
      // without requiring a `users` login account or smartphone.
      const eligible = await findEligibleHandymanWorker(tx, {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        workerContextId: targetHelperWorkerId,
        providerContextId: activeAssignment.handymanProviderContextId,
        requireLogin: false,
      });
      if (!eligible) {
        throw new AppError({
          statusCode: 409,
          code: ERROR_CODES.HANDYMAN_HELPER_ROSTER_CHANGE_CONFLICT,
          message: `Target Helper (${targetHelperWorkerId}) is not an eligible ACTIVE worker placed at this Building.`,
        });
      }
      targetHelperUserId = eligible.userId;
    }

    const activeSessionRes = await tx.query<{ id: string }>(
      `SELECT id
         FROM handyman_work_sessions
        WHERE execution_scope_id = $1
          AND status <> 'CHECKED_OUT'
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [ctx.executionScopeId],
    );
    const activeSessionId = activeSessionRes.rows[0]?.id ?? null;

    const personnelChange =
      await handymanHelperAttendanceRepository.insertPersonnelChange(tx, {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        handymanRequestId: ctx.handymanRequestId,
        executionScopeId: ctx.executionScopeId,
        workOrderId,
        assignmentId: activeAssignment.id,
        crewId: activeAssignment.handymanCrewId,
        workSessionId: activeSessionId,
        changeType,
        targetHelperWorkerId,
        targetHelperUserId,
        replacedHelperWorkerId,
        replacedHelperUserId,
        reason,
        authorizedByUserId: validActorId,
        idempotencyKey,
      });

    // If an active Work Session already had `replacedHelperWorkerId` confirmed
    // as `HADIR`, automatically supersede it to `TIDAK_HADIR` with an
    // append-only `ROSTER_REMOVED_SUPERSEDED` audit event so a substituted-out
    // or removed helper never remains counted as verified present.
    if (activeSessionId && replacedHelperWorkerId) {
      const existingConf =
        await handymanHelperAttendanceRepository.findConfirmationForUpdate(
          tx,
          activeSessionId,
          replacedHelperWorkerId,
        );
      if (existingConf && existingConf.attendanceStatus === 'HADIR') {
        const updatedConf =
          await handymanHelperAttendanceRepository.updateConfirmation(tx, {
            id: existingConf.id,
            workOrderId,
            attendanceStatus: 'TIDAK_HADIR',
            confirmedByUserId: validActorId,
            confirmedByWorkerId: null,
            notes: existingConf.latestNotes,
            correctionReason: reason,
          });
        await handymanHelperAttendanceRepository.insertEvent(tx, {
          confirmationId: updatedConf.id,
          clientId: ctx.clientId,
          buildingId: ctx.buildingId,
          handymanRequestId: ctx.handymanRequestId,
          executionScopeId: ctx.executionScopeId,
          workOrderId: updatedConf.workOrderId,
          workSessionId: activeSessionId,
          helperWorkerId: replacedHelperWorkerId,
          helperUserId: replacedHelperUserId,
          eventType: 'ROSTER_REMOVED_SUPERSEDED',
          previousStatus: 'HADIR',
          newStatus: 'TIDAK_HADIR',
          notes: `Superseded by Operations ${changeType} (${personnelChange.id})`,
          correctionReason: reason,
          actorUserId: validActorId,
          actorWorkerId: null,
          actorRole: 'OPERATIONS',
          idempotencyKey: `ops-supersede:${personnelChange.id}`,
        });
      }
    }

    await recordOperationalEvent(
      {
        clientId: ctx.clientId,
        buildingId: ctx.buildingId,
        actorUserId: validActorId,
        eventType: `handyman_helper_roster.${changeType.toLowerCase()}`,
        entityType: 'handyman_execution_scope',
        entityId: ctx.executionScopeId,
        summary: `Authorized helper roster ${changeType} on Execution Scope ${ctx.executionScopeId}.`,
        metadata: {
          personnelChangeId: personnelChange.id,
          changeType,
          targetHelperWorkerId,
          replacedHelperWorkerId,
          workOrderId,
        },
      },
      tx,
    );

    const projection = await buildProjection(tx, ctx, activeSessionId);
    return {
      personnelChange,
      projection,
      replayed: false,
    };
  });
}

import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { handymanExecutionScopeNotFoundError }
  from '../handyman-quotations';
import {
  handymanScopeAssignmentRepository,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';
import {
  handymanWorkSessionActiveConflictError,
  handymanWorkSessionArrivalRequiredError,
  handymanWorkSessionIllegalTransitionError,
  handymanWorkSessionNotAuthorizedError,
  handymanWorkSessionNotFoundError,
  handymanWorkSessionScopeNotEligibleError,
  handymanWorkSessionStaleConflictError,
  handymanWorkSessionValidationError,
} from './handyman-work-session.errors';
import { handymanWorkSessionRepository }
  from './handyman-work-session.repository';
import type {
  HandymanWorkSessionEventRecord,
  HandymanWorkSessionHelperPresenceRecord,
  HandymanWorkSessionRecord,
} from './handyman-work-session.types';

/**
 * CR-HM-08 PART 02 — CHECK_IN + START_WORK commands ONLY (FROZEN
 * governance `CR-HM-08_START_GOVERNANCE.md` §3/§4/§5/§7/§11).
 * Composition of existing authorities ONLY: CR-HM-06 AUTHORIZED
 * scope gate, CR-HM-07 immutable VERIFIED arrival result (read-only
 * prerequisite — arrival is NEVER mutated here),
 * `resolveHandymanAssignmentLead` for CURRENT Lead authority, CR-HM-04
 * ACTIVE crew membership for the server-derived helper snapshot.
 *
 * CHECK_IN accepts ONLY executionScopeId + idempotencyKey; commands
 * for an existing session accept ONLY sessionId + idempotencyKey. The
 * actor comes from authenticated context. Caller-supplied crew id,
 * worker id, assignment id, helper list, arrival result id, or
 * timestamps are NEVER accepted/derived. Writes are atomic with
 * server-clock timestamps; exact command/session/key retries replay
 * their stored result, never a second transition/session.
 *
 * NOT here: PAUSE / RESUME / MATERIAL_RUN / COMPLETE / CHECK_OUT
 * (PART 03+), billing, HTTP/OpenAPI, FM.
 */

export type HandymanWorkSessionCheckInInput = {
  executionScopeId: string;
  idempotencyKey: string;
};

export type HandymanWorkSessionStartWorkInput = {
  sessionId: string;
  idempotencyKey: string;
};

export type HandymanWorkSessionCheckInResult = {
  session: HandymanWorkSessionRecord;
  event: HandymanWorkSessionEventRecord;
  helperPresence: HandymanWorkSessionHelperPresenceRecord[];
  replayed: boolean;
};

export type HandymanWorkSessionStartWorkResult = {
  session: HandymanWorkSessionRecord;
  event: HandymanWorkSessionEventRecord;
  replayed: boolean;
};

/** PART 03 result surface is identical in shape (session + event). */
export type HandymanWorkSessionWorkClockResult =
  HandymanWorkSessionStartWorkResult;

/** Frozen PART 03 work-clock transitions (governance §5/§9). */
type WorkClockAction = 'PAUSE' | 'MATERIAL_RUN' | 'RESUME';

const WORK_CLOCK_RULES: Record<WorkClockAction, {
  from: readonly string[];
  to: string;
}> = {
  PAUSE: { from: ['IN_PROGRESS'], to: 'PAUSED' },
  MATERIAL_RUN: { from: ['IN_PROGRESS'], to: 'MATERIAL_RUN' },
  RESUME: { from: ['PAUSED', 'MATERIAL_RUN'], to: 'IN_PROGRESS' },
};

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw handymanWorkSessionValidationError(field);
  }
  return raw;
}

function ensureKey(value: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw.length === 0 || raw.length > 200) {
    throw handymanWorkSessionValidationError('idempotencyKey');
  }
  return raw;
}

/**
 * Reads the immutable CR-HM-07 contract ONLY: does a VERIFIED
 * arrival result exist for THIS execution scope? NO mutation, NO
 * re-evaluation, NO caller-supplied result id.
 */
async function findVerifiedArrivalResultId(
  executor: Pick<PoolClient, 'query'> = getPool(),
  executionScopeId: string,
): Promise<string | null> {
  const result = await executor.query(
    `SELECT id FROM handyman_arrival_verification_results
      WHERE execution_scope_id = $1 AND status = 'VERIFIED'
      ORDER BY created_at DESC LIMIT 1`,
    [executionScopeId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * Server-derived helper snapshot source (governance §7): the CURRENT
 * ACTIVE memberships of the session assignment's crew, MINUS the
 * Lead — resolved helper worker contexts with their (nullable) login
 * identity. Caller input invisible here by construction.
 */
async function listCurrentHelperRows(
  executor: Pick<PoolClient, 'query'>,
  crewId: string,
  leadWorkerId: string,
): Promise<Array<{ workerId: string; userId: string | null }>> {
  const result = await executor.query(
    `SELECT m.handyman_worker_context_id AS worker_id,
            wp.user_id AS user_id
       FROM handyman_crew_memberships m
       JOIN handyman_worker_contexts wc
         ON wc.id = m.handyman_worker_context_id
       JOIN workforce_profiles wp
         ON wp.id = wc.workforce_profile_id
      WHERE m.handyman_crew_id = $1
        AND m.status = 'ACTIVE'
        AND m.handyman_worker_context_id <> $2
      ORDER BY m.created_at, m.id`,
    [crewId, leadWorkerId],
  );
  return result.rows.map((row) => ({
    workerId: row.worker_id as string,
    userId: (row.user_id as string | null) ?? null,
  }));
}

/**
 * Shared authority preamble for PART 02 commands: scope exists +
 * AUTHORIZED, client context, CURRENT Lead resolution. Returns the
 * scope, resolution, and the actor's client id.
 */
async function authorityPreamble(
  scopeUuid: string,
  actorUserId: string,
) {
  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId,
    scope.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }
  const resolution = await resolveHandymanAssignmentLead(
    scopeUuid,
    actorUserId,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw handymanWorkSessionNotAuthorizedError();
  }
  return { scope, resolution };
}

/** Resolves authorization from the requested session's persisted scope. */
async function sessionCommandPreamble(
  sessionId: string,
  actorUserId: string,
) {
  const target = await handymanWorkSessionRepository
    .findWorkSessionById(undefined, sessionId);
  if (!target) throw handymanWorkSessionNotFoundError();
  const { resolution } = await authorityPreamble(
    target.executionScopeId,
    actorUserId,
  );
  return { resolution };
}

/** Locks and re-reads exactly one target row before replay or transition. */
async function lockWorkSession(
  tx: PoolClient,
  sessionId: string,
): Promise<HandymanWorkSessionRecord> {
  const locked = await tx.query(
    `SELECT id FROM handyman_work_sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  if (locked.rows.length === 0) throw handymanWorkSessionNotFoundError();
  const current = await handymanWorkSessionRepository
    .findWorkSessionById(tx, sessionId);
  if (!current) throw handymanWorkSessionNotFoundError();
  return current;
}

/**
 * CHECK_IN (governance §3/§5/§7): AUTHORIZED scope + immutable
 * CR-HM-07 VERIFIED arrival result + CURRENT authoritative Crew Lead
 * → create ONE CHECKED_IN session, append the CHECK_IN event, and
 * snapshot CURRENT helper crew membership — atomically, server-clock
 * timestamps only. The same scope/key CHECK_IN retry resolves against
 * event history before active-session checks, including after closure;
 * a distinct key conflicts with any currently active session.
 */
export async function checkInHandymanWorkSession(
  input: HandymanWorkSessionCheckInInput,
  actorUserId: string,
): Promise<HandymanWorkSessionCheckInResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  const { resolution } = await authorityPreamble(
    scopeUuid,
    actorUuid,
  );

  return withTransaction(async (tx) => {
    // Serialize check-in attempts even when the scope has no active
    // session yet. This makes the scope/key replay lookup race-safe.
    const scopeLock = await tx.query(
      `SELECT id FROM handyman_execution_scopes
        WHERE id = $1 FOR UPDATE`,
      [scopeUuid],
    );
    if (scopeLock.rows.length === 0) {
      throw handymanExecutionScopeNotFoundError();
    }
    const scope = await handymanScopeAssignmentRepository
      .findScopeById(tx, scopeUuid);
    if (!scope) throw handymanExecutionScopeNotFoundError();

    // CHECK_IN has no pre-existing sessionId. Its stable replay key is
    // therefore resolved across this scope's complete event history,
    // before any new-session preconditions or active-session lookup.
    const replayEvent = await handymanWorkSessionRepository
      .findWorkSessionCheckInEventByIdempotency(tx, scopeUuid, key);
    if (replayEvent) {
      const priorSession = await handymanWorkSessionRepository
        .findWorkSessionById(tx, replayEvent.sessionId);
      if (!priorSession) throw handymanWorkSessionNotFoundError();
      const helperPresence = await handymanWorkSessionRepository
        .listWorkSessionHelperPresenceBySession(tx, priorSession.id);
      const checkInPresence = helperPresence.filter(
        (presence) => presence.eventId === replayEvent.id,
      );
      return {
        session: priorSession,
        event: replayEvent,
        helperPresence: checkInPresence,
        replayed: true,
      };
    }

    if (scope.status !== 'AUTHORIZED') {
      throw handymanWorkSessionScopeNotEligibleError();
    }
    if (!(await findVerifiedArrivalResultId(tx, scopeUuid))) {
      throw handymanWorkSessionArrivalRequiredError(scopeUuid);
    }

    const existing = await handymanWorkSessionRepository
      .findActiveWorkSessionByExecutionScope(tx, scopeUuid);
    if (existing) {
      throw handymanWorkSessionActiveConflictError(scopeUuid);
    }

    const session = await handymanWorkSessionRepository
      .createWorkSession(tx, {
        clientId: scope.clientId,
        executionScopeId: scopeUuid,
        assignmentId: resolution.assignmentId,
        leadWorkerId: resolution.leadWorkerContextId,
        leadUserId: resolution.leadUserId,
      });
    const event = await handymanWorkSessionRepository
      .appendWorkSessionEvent(tx, {
        clientId: scope.clientId,
        sessionId: session.id,
        executionScopeId: scopeUuid,
        eventType: 'CHECK_IN',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    // Helper snapshot: server-derived CURRENT crew membership minus
    // the Lead; presence evidence only, NEVER billable manpower.
    const helpers = await listCurrentHelperRows(
      tx,
      resolution.crewId,
      resolution.leadWorkerContextId,
    );
    const helperPresence = [] as
      HandymanWorkSessionHelperPresenceRecord[];
    for (const helper of helpers) {
      helperPresence.push(await handymanWorkSessionRepository
        .insertWorkSessionHelperPresence(tx, {
          clientId: scope.clientId,
          sessionId: session.id,
          eventId: event.id,
          executionScopeId: scopeUuid,
          helperWorkerId: helper.workerId,
          helperUserId: helper.userId,
        }));
    }
    return { session, event, helperPresence, replayed: false };
  });
}

/**
 * START_WORK (governance §5): same CURRENT authoritative Lead;
 * session must be CHECKED_IN → transitions to IN_PROGRESS with
 * server-clock startedWorkAt and appends the START_WORK event —
 * atomically. The exact session/key replay is checked before state
 * validation, including after CHECKED_OUT; a new command against a
 * closed target is a bounded stale 409. A missing session is 404.
 */
export async function startWorkHandymanWorkSession(
  input: HandymanWorkSessionStartWorkInput,
  actorUserId: string,
): Promise<HandymanWorkSessionStartWorkResult> {
  const sessionId = ensureUuid(input.sessionId, 'sessionId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  await sessionCommandPreamble(sessionId, actorUuid);

  return withTransaction(async (tx) => {
    const current = await lockWorkSession(tx, sessionId);
    const replayEvent = await handymanWorkSessionRepository
      .findWorkSessionEventByIdempotency(tx, sessionId,
        'START_WORK', key);
    if (replayEvent) {
      return { session: current, event: replayEvent, replayed: true };
    }
    if (current.status === 'CHECKED_OUT') {
      throw handymanWorkSessionStaleConflictError(sessionId);
    }

    const transitioned = await tx.query(
      `UPDATE handyman_work_sessions
          SET status = 'IN_PROGRESS', started_work_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 AND status = 'CHECKED_IN'
        RETURNING id, client_id, execution_scope_id, assignment_id,
                  lead_worker_id, lead_user_id, status, checked_in_at,
                  started_work_at, completed_at, checked_out_at,
                  created_at, updated_at`,
      [sessionId],
    );
    if (transitioned.rows.length === 0) {
      throw handymanWorkSessionIllegalTransitionError(
        current.status,
        'START_WORK',
      );
    }
    const event = await handymanWorkSessionRepository
      .appendWorkSessionEvent(tx, {
        clientId: current.clientId,
        sessionId,
        executionScopeId: current.executionScopeId,
        eventType: 'START_WORK',
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    const row = transitioned.rows[0];
    return {
      session: {
        id: row.id,
        clientId: row.client_id,
        executionScopeId: row.execution_scope_id,
        assignmentId: row.assignment_id,
        leadWorkerId: row.lead_worker_id,
        leadUserId: row.lead_user_id,
        status: row.status,
        checkedInAt: row.checked_in_at,
        startedWorkAt: row.started_work_at,
        completedAt: row.completed_at,
        checkedOutAt: row.checked_out_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      event,
      replayed: false,
    };
  });
}

/**
 * PART 03 shared session-bound work-clock transition (governance
 * §5/§6/§9/§11). Lock the requested row → exact replay check → stale
 * terminal check → conditional transition/event in ONE transaction.
 * TIME SEMANTICS: only the status column moves — IN_PROGRESS keeps
 * the actual-work clock open,
 * PAUSED / MATERIAL_RUN halt it; presence is untouched in all three.
 * NO started_work_at mutation, NO timestamps from the caller, NO
 * billable/rate/charge computation, NO material truth (CR-HM-09).
 */
async function workClockTransition(
  input: HandymanWorkSessionStartWorkInput,
  actorUserId: string,
  action: WorkClockAction,
): Promise<HandymanWorkSessionWorkClockResult> {
  const sessionId = ensureUuid(input.sessionId, 'sessionId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const rule = WORK_CLOCK_RULES[action];

  await sessionCommandPreamble(sessionId, actorUuid);

  return withTransaction(async (tx) => {
    const current = await lockWorkSession(tx, sessionId);
    const replayEvent = await handymanWorkSessionRepository
      .findWorkSessionEventByIdempotency(tx, sessionId, action, key);
    if (replayEvent) {
      return { session: current, event: replayEvent, replayed: true };
    }
    if (current.status === 'CHECKED_OUT') {
      throw handymanWorkSessionStaleConflictError(sessionId);
    }

    const transitioned = await tx.query(
      `UPDATE handyman_work_sessions
          SET status = $2, updated_at = NOW()
        WHERE id = $1 AND status = ANY($3::text[])
        RETURNING id, client_id, execution_scope_id, assignment_id,
                  lead_worker_id, lead_user_id, status, checked_in_at,
                  started_work_at, completed_at, checked_out_at,
                  created_at, updated_at`,
      [sessionId, rule.to, [...rule.from]],
    );
    if (transitioned.rows.length === 0) {
      throw handymanWorkSessionIllegalTransitionError(
        current.status,
        action,
      );
    }
    const event = await handymanWorkSessionRepository
      .appendWorkSessionEvent(tx, {
        clientId: current.clientId,
        sessionId,
        executionScopeId: current.executionScopeId,
        eventType: action,
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    const row = transitioned.rows[0];
    return {
      session: {
        id: row.id,
        clientId: row.client_id,
        executionScopeId: row.execution_scope_id,
        assignmentId: row.assignment_id,
        leadWorkerId: row.lead_worker_id,
        leadUserId: row.lead_user_id,
        status: row.status,
        checkedInAt: row.checked_in_at,
        startedWorkAt: row.started_work_at,
        completedAt: row.completed_at,
        checkedOutAt: row.checked_out_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      event,
      replayed: false,
    };
  });
}

/**
 * PAUSE (§5): IN_PROGRESS → PAUSED. Actual-work clock halts; the
 * session and presence stay live. Atomic + idempotent per key.
 */
export async function pauseHandymanWorkSession(
  input: HandymanWorkSessionStartWorkInput,
  actorUserId: string,
): Promise<HandymanWorkSessionWorkClockResult> {
  return workClockTransition(input, actorUserId, 'PAUSE');
}

/**
 * MATERIAL_RUN (§9): IN_PROGRESS → MATERIAL_RUN. A bounded work-
 * clock halting for material acquisition; the session and presence
 * are PRESERVED. Material truth (issued/purchased/used) is CR-HM-09
 * — zero coupling here. Atomic + idempotent per key.
 */
export async function materialRunHandymanWorkSession(
  input: HandymanWorkSessionStartWorkInput,
  actorUserId: string,
): Promise<HandymanWorkSessionWorkClockResult> {
  return workClockTransition(input, actorUserId, 'MATERIAL_RUN');
}

/**
 * RESUME (§5): PAUSED → IN_PROGRESS or MATERIAL_RUN → IN_PROGRESS.
 * The actual-work clock re-opens; presence was never interrupted.
 * Atomic + idempotent per key.
 */
export async function resumeHandymanWorkSession(
  input: HandymanWorkSessionStartWorkInput,
  actorUserId: string,
): Promise<HandymanWorkSessionWorkClockResult> {
  return workClockTransition(input, actorUserId, 'RESUME');
}

/** Frozen PART 04 transitions (governance §5/§10). */
type SessionCloseAction = 'COMPLETE' | 'CHECK_OUT';

const SESSION_CLOSE_RULES: Record<SessionCloseAction, {
  from: readonly string[];
  to: string;
}> = {
  COMPLETE: {
    from: ['IN_PROGRESS', 'PAUSED', 'MATERIAL_RUN'],
    to: 'COMPLETED',
  },
  CHECK_OUT: { from: ['CHECKED_IN', 'COMPLETED'], to: 'CHECKED_OUT' },
};

/**
 * PART 04 shared session-bound closing transition (governance
 * §5/§10/§11). Lock the requested row → exact replay (including after
 * checkout) → stale terminal check → conditional transition and event;
 * CHECK_OUT also snapshots current helper presence, all in ONE
 * transaction.
 *
 * BOUNDARIES (FROZEN §10): COMPLETE means FIELD WORK COMPLETE only —
 * it never completes QC, accepts BAST, settles payment, closes
 * warranty, or calculates billing. CHECK_OUT closes PRESENCE only —
 * it is NOT customer acceptance. No downstream state is touched,
 * emitted, or implied here.
 */
async function sessionCloseTransition(
  input: HandymanWorkSessionStartWorkInput,
  actorUserId: string,
  action: SessionCloseAction,
): Promise<HandymanWorkSessionWorkClockResult> {
  const sessionId = ensureUuid(input.sessionId, 'sessionId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const rule = SESSION_CLOSE_RULES[action];

  const { resolution } = await sessionCommandPreamble(
    sessionId,
    actorUuid,
  );

  return withTransaction(async (tx) => {
    const current = await lockWorkSession(tx, sessionId);
    const replayEvent = await handymanWorkSessionRepository
      .findWorkSessionEventByIdempotency(tx, sessionId, action, key);
    if (replayEvent) {
      return { session: current, event: replayEvent, replayed: true };
    }
    if (current.status === 'CHECKED_OUT') {
      throw handymanWorkSessionStaleConflictError(sessionId);
    }

    const transitioned = await tx.query(
      `UPDATE handyman_work_sessions
          SET status = $2, completed_at = CASE WHEN $2 = 'COMPLETED'
                THEN NOW() ELSE completed_at END,
              checked_out_at = CASE WHEN $2 = 'CHECKED_OUT'
                THEN NOW() ELSE checked_out_at END,
              updated_at = NOW()
        WHERE id = $1 AND status = ANY($3::text[])
        RETURNING id, client_id, execution_scope_id, assignment_id,
                  lead_worker_id, lead_user_id, status, checked_in_at,
                  started_work_at, completed_at, checked_out_at,
                  created_at, updated_at`,
      [sessionId, rule.to, [...rule.from]],
    );
    if (transitioned.rows.length === 0) {
      throw handymanWorkSessionIllegalTransitionError(
        current.status,
        action,
      );
    }
    const event = await handymanWorkSessionRepository
      .appendWorkSessionEvent(tx, {
        clientId: current.clientId,
        sessionId,
        executionScopeId: current.executionScopeId,
        eventType: action,
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    if (action === 'CHECK_OUT') {
      // Presence CLOSURE snapshot (governance §7): the CURRENT helper
      // roster minus the Lead, bound to the CHECK_OUT event —
      // server-derived, presence evidence only.
      const helpers = await listCurrentHelperRows(
        tx,
        resolution.crewId,
        resolution.leadWorkerContextId,
      );
      for (const helper of helpers) {
        await handymanWorkSessionRepository
          .insertWorkSessionHelperPresence(tx, {
            clientId: current.clientId,
            sessionId,
            eventId: event.id,
            executionScopeId: current.executionScopeId,
            helperWorkerId: helper.workerId,
            helperUserId: helper.userId,
          });
      }
    }
    const row = transitioned.rows[0];
    return {
      session: {
        id: row.id,
        clientId: row.client_id,
        executionScopeId: row.execution_scope_id,
        assignmentId: row.assignment_id,
        leadWorkerId: row.lead_worker_id,
        leadUserId: row.lead_user_id,
        status: row.status,
        checkedInAt: row.checked_in_at,
        startedWorkAt: row.started_work_at,
        completedAt: row.completed_at,
        checkedOutAt: row.checked_out_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      event,
      replayed: false,
    };
  });
}

/**
 * COMPLETE (§10): field-worker-declared WORK COMPLETE only. From
 * IN_PROGRESS / PAUSED / MATERIAL_RUN → COMPLETED with server-clock
 * completedAt. NEVER QC complete, BAST accepted, payment settled,
 * warranty closed, or billing calculated (downstream firewall §12).
 */
export async function completeHandymanWorkSession(
  input: HandymanWorkSessionStartWorkInput,
  actorUserId: string,
): Promise<HandymanWorkSessionWorkClockResult> {
  return sessionCloseTransition(input, actorUserId, 'COMPLETE');
}

/**
 * CHECK_OUT (§10): presence CLOSURE only. From CHECKED_IN (abandon,
 * no work started) or COMPLETED → CHECKED_OUT with server-clock
 * checkedOutAt and the CURRENT helper-presence closure snapshot.
 * NEVER customer acceptance (CR-HM-11).
 */
export async function checkOutHandymanWorkSession(
  input: HandymanWorkSessionStartWorkInput,
  actorUserId: string,
): Promise<HandymanWorkSessionWorkClockResult> {
  return sessionCloseTransition(input, actorUserId, 'CHECK_OUT');
}

/**
 * Internal READ-ONLY time projection for one exact sessionId over the
 * append-only event stream (governance §6/§11 — the stream is the ONLY
 * authority). The session's persisted scope supplies authorization:
 *
 *   presenceTime    — CHECK_IN event → CHECK_OUT event; for an open
 *                     session the tail projects against server-now
 *                     (NOTHING is persisted or fabricated).
 *   actualWorkTime  — SUM of intervals where the work clock was
 *                     OPEN: [START_WORK|RESUME] → [PAUSE|MATERIAL_RUN|
 *                     COMPLETE|CHECK_OUT]. PAUSED and MATERIAL_RUN
 *                     intervals are EXCLUDED; a still-open tail uses
 *                     server-now.
 *
 * NO billable time, NO rate, NO charge can exist here (§6).
 */
export type HandymanWorkSessionTimeProjection = {
  sessionId: string;
  executionScopeId: string;
  status: string;
  presenceSeconds: number;
  actualWorkSeconds: number;
  sessionClosed: boolean;
  /** Server-now instant used for open-tail projections. */
  projectedAt: Date;
};

function computeSessionTimeFromEvents(
  events: HandymanWorkSessionEventRecord[],
  serverNow: Date,
): {
  presenceSeconds: number;
  actualWorkSeconds: number;
  sessionClosed: boolean;
} {
  let presenceSeconds = 0;
  let actualWorkSeconds = 0;
  let workClockOpenedAt: Date | null = null;
  let checkedInAt: Date | null = null;
  let checkedOutAt: Date | null = null;
  const ms = (a: Date, b: Date) => Math.max(0, b.getTime() - a.getTime());

  for (const event of events) {
    const at = event.occurredAt;
    if (event.eventType === 'CHECK_IN') checkedInAt = at;
    if (event.eventType === 'START_WORK' || event.eventType === 'RESUME') {
      workClockOpenedAt = at;
    }
    if (
      event.eventType === 'PAUSE' ||
      event.eventType === 'MATERIAL_RUN' ||
      event.eventType === 'COMPLETE'
    ) {
      if (workClockOpenedAt) {
        actualWorkSeconds += ms(workClockOpenedAt, at) / 1000;
        workClockOpenedAt = null;
      }
    }
    if (event.eventType === 'CHECK_OUT') {
      checkedOutAt = at;
      if (workClockOpenedAt) {
        actualWorkSeconds += ms(workClockOpenedAt, at) / 1000;
        workClockOpenedAt = null;
      }
    }
  }
  if (workClockOpenedAt) {
    actualWorkSeconds += ms(workClockOpenedAt, serverNow) / 1000;
  }
  if (checkedInAt) {
    presenceSeconds = ms(checkedInAt, checkedOutAt ?? serverNow) / 1000;
  }

  return {
    presenceSeconds,
    actualWorkSeconds,
    sessionClosed: checkedOutAt !== null,
  };
}

export async function getHandymanWorkSessionTimeProjection(
  sessionId: string,
  actorUserId: string,
): Promise<HandymanWorkSessionTimeProjection> {
  const sessionUuid = ensureUuid(sessionId, 'sessionId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const session = await handymanWorkSessionRepository
    .findWorkSessionById(undefined, sessionUuid);
  if (!session) throw handymanWorkSessionNotFoundError();

  // Authorization is resolved from this exact session's persisted scope;
  // never substitute another/latest session from the same scope.
  await authorityPreamble(session.executionScopeId, actorUuid);

  // Consistent read of the requested session's event stream under the
  // SERVER clock.
  const nowRow = await getPool().query(
    `SELECT NOW() AS server_now`);
  const serverNow: Date = nowRow.rows[0].server_now;

  const events = await handymanWorkSessionRepository
    .listWorkSessionEventsBySession(undefined, session.id);
  const { presenceSeconds, actualWorkSeconds, sessionClosed } =
    computeSessionTimeFromEvents(events, serverNow);

  return {
    sessionId: session.id,
    executionScopeId: session.executionScopeId,
    status: session.status,
    presenceSeconds,
    actualWorkSeconds,
    sessionClosed,
    projectedAt: serverNow,
  };
}

/**
 * PART 05 READ accessor — the ACTIVE (non-CHECKED_OUT) session for a
 * scope under the same Lead authority preamble. Read-only; NO
 * lifecycle effect.
 */
export type HandymanWorkSessionActiveResult = {
  session: HandymanWorkSessionRecord;
  helperPresence: HandymanWorkSessionHelperPresenceRecord[];
};

export async function getActiveHandymanWorkSession(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanWorkSessionActiveResult> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await authorityPreamble(scopeUuid, actorUuid);
  const session = await handymanWorkSessionRepository
    .findActiveWorkSessionByExecutionScope(undefined, scopeUuid);
  if (!session) throw handymanWorkSessionNotFoundError();
  const helperPresence = await handymanWorkSessionRepository
    .listWorkSessionHelperPresenceBySession(undefined, session.id);
  return { session, helperPresence };
}

/**
 * CR-HM-17 GAP PART 03 — Customer Care work session read item
 * (active + CHECKED_OUT sessions, events, helper presence, and
 * server-derived presenceSeconds + actualWorkSeconds).
 */
export type HandymanCustomerCareWorkSessionItem = {
  session: HandymanWorkSessionRecord;
  events: HandymanWorkSessionEventRecord[];
  helperPresence: HandymanWorkSessionHelperPresenceRecord[];
  presenceSeconds: number;
  actualWorkSeconds: number;
  sessionClosed: boolean;
  projectedAt: Date;
};

export type HandymanCustomerCareWorkSessionsProjection = {
  executionScopeId: string;
  activeSession: HandymanCustomerCareWorkSessionItem | null;
  sessions: HandymanCustomerCareWorkSessionItem[];
  presenceSeconds: number;
  actualWorkSeconds: number;
  projectedAt: Date;
};

/**
 * CR-HM-17 GAP PART 03 — Customer Care read projection for all work
 * sessions (active + CHECKED_OUT) on an execution scope. Enforces
 * `canAccessClient(actorUserId, scope.clientId)` without requiring
 * Crew Lead identity.
 */
export async function getHandymanWorkSessionsCustomerCareView(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanCustomerCareWorkSessionsProjection> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');

  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();

  const allowed = await contextAccessService.canAccessClient(
    actorUuid,
    scope.clientId,
  );
  if (!allowed) throw buildingAccessDeniedError();

  const nowRow = await getPool().query(`SELECT NOW() AS server_now`);
  const serverNow: Date = nowRow.rows[0].server_now;

  const sessionRows = await handymanWorkSessionRepository
    .listWorkSessionsByExecutionScope(undefined, scopeUuid);

  const sessions: HandymanCustomerCareWorkSessionItem[] = [];
  let totalPresenceSeconds = 0;
  let totalActualWorkSeconds = 0;

  for (const session of sessionRows) {
    const [events, helperPresence] = await Promise.all([
      handymanWorkSessionRepository.listWorkSessionEventsBySession(
        undefined,
        session.id,
      ),
      handymanWorkSessionRepository.listWorkSessionHelperPresenceBySession(
        undefined,
        session.id,
      ),
    ]);
    const { presenceSeconds, actualWorkSeconds, sessionClosed } =
      computeSessionTimeFromEvents(events, serverNow);
    totalPresenceSeconds += presenceSeconds;
    totalActualWorkSeconds += actualWorkSeconds;

    sessions.push({
      session,
      events,
      helperPresence,
      presenceSeconds,
      actualWorkSeconds,
      sessionClosed,
      projectedAt: serverNow,
    });
  }

  const activeSession =
    sessions.find((item) => item.session.status !== 'CHECKED_OUT') ?? null;

  return {
    executionScopeId: scopeUuid,
    activeSession,
    sessions,
    presenceSeconds: totalPresenceSeconds,
    actualWorkSeconds: totalActualWorkSeconds,
    projectedAt: serverNow,
  };
}

export const listHandymanWorkSessionsByScope =
  getHandymanWorkSessionsCustomerCareView;

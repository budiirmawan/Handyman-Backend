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
 * The caller supplies ONLY executionScopeId + idempotencyKey; the
 * actor comes from the authenticated context. Caller-supplied crew
 * id, worker id, assignment id, helper list, arrival result id, or
 * timestamps are NEVER accepted/derived. All writes are one atomic
 * transaction with server-clock timestamps. Idempotent replay of the
 * same key returns the SAME session/event, never a second row.
 *
 * NOT here: PAUSE / RESUME / MATERIAL_RUN / COMPLETE / CHECK_OUT
 * (PART 03+), billing, HTTP/OpenAPI, FM.
 */

export type HandymanWorkSessionCheckInInput = {
  executionScopeId: string;
  idempotencyKey: string;
};

export type HandymanWorkSessionStartWorkInput = {
  executionScopeId: string;
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

/**
 * CHECK_IN (governance §3/§5/§7): AUTHORIZED scope + immutable
 * CR-HM-07 VERIFIED arrival result + CURRENT authoritative Crew Lead
 * → create ONE CHECKED_IN session, append the CHECK_IN event, and
 * snapshot CURRENT helper crew membership — atomically, server-clock
 * timestamps only. Replay of the same idempotency key returns the
 * SAME session/event; any other active session is a bounded 409
 * active-conflict.
 */
export async function checkInHandymanWorkSession(
  input: HandymanWorkSessionCheckInInput,
  actorUserId: string,
): Promise<HandymanWorkSessionCheckInResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  const { scope, resolution } = await authorityPreamble(
    scopeUuid,
    actorUuid,
  );
  if (scope.status !== 'AUTHORIZED') {
    throw handymanWorkSessionScopeNotEligibleError();
  }
  if (!(await findVerifiedArrivalResultId(undefined, scopeUuid))) {
    throw handymanWorkSessionArrivalRequiredError(scopeUuid);
  }

  return withTransaction(async (tx) => {
    const existing = await handymanWorkSessionRepository
      .findActiveWorkSessionByExecutionScope(tx, scopeUuid);
    if (existing) {
      // Idempotent replay: the SAME check-in key replays the SAME
      // session/event (never a second row).
      const replayEvent = await handymanWorkSessionRepository
        .findWorkSessionEventByIdempotency(tx, existing.id,
          'CHECK_IN', key);
      if (replayEvent) {
        const helperPresence = await handymanWorkSessionRepository
          .listWorkSessionHelperPresenceBySession(tx, existing.id);
        return { session: existing, event: replayEvent,
          helperPresence, replayed: true };
      }
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
 * atomically. Replay of the same key returns the SAME recorded
 * event. Any other status is a bounded 409 illegal transition; no
 * active session is a bounded 404.
 */
export async function startWorkHandymanWorkSession(
  input: HandymanWorkSessionStartWorkInput,
  actorUserId: string,
): Promise<HandymanWorkSessionStartWorkResult> {
  const scopeUuid = ensureUuid(input.executionScopeId,
    'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  await authorityPreamble(scopeUuid, actorUuid);

  return withTransaction(async (tx) => {
    // Row lock first: transitions are single-threaded per session.
    const locked = await tx.query(
      `SELECT id FROM handyman_work_sessions
        WHERE execution_scope_id = $1 AND status <> 'CHECKED_OUT'
        FOR UPDATE`,
      [scopeUuid],
    );
    const sessionId = locked.rows[0]?.id as string | undefined;
    if (!sessionId) throw handymanWorkSessionNotFoundError();

    // Idempotent replay BEFORE the transition check: a recorded
    // START_WORK with the same key replays the original evidence.
    const replayEvent = await handymanWorkSessionRepository
      .findWorkSessionEventByIdempotency(tx, sessionId,
        'START_WORK', key);
    const current = await handymanWorkSessionRepository
      .findWorkSessionById(tx, sessionId);
    if (!current) throw handymanWorkSessionNotFoundError();
    if (replayEvent) {
      return { session: current, event: replayEvent, replayed: true };
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
        executionScopeId: scopeUuid,
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

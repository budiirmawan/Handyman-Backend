import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  checkInHandymanWorkSession,
  checkOutHandymanWorkSession,
  completeHandymanWorkSession,
  getActiveHandymanWorkSession,
  getHandymanWorkSessionsCustomerCareView,
  getHandymanWorkSessionTimeProjection,
  handymanWorkSessionNotFoundError,
  materialRunHandymanWorkSession,
  pauseHandymanWorkSession,
  resumeHandymanWorkSession,
  startWorkHandymanWorkSession,
} from '../handyman-work-sessions';
import type {
  HandymanCustomerCareWorkSessionItem,
  HandymanCustomerCareWorkSessionsProjection,
  HandymanWorkSessionActiveResult,
  HandymanWorkSessionEventRecord,
  HandymanWorkSessionRecord,
  HandymanWorkSessionTimeProjection,
  HandymanWorkSessionWorkClockResult,
} from '../handyman-work-sessions';
import { handymanWorkSessionRepository }
  from '../handyman-work-sessions';
import {
  parseWorkSessionIdParam,
  parseWorkSessionMutationBody,
  parseWorkSessionScopeParam,
} from './handyman-work-sessions-api.validation';

/**
 * CR-HM-08 PART 05 — work-session HTTP handlers (THIN shell). Each
 * handler does EXACTLY: auth/context → bounded whitelist validation →
 * the matching PART 02–04 service → bounded serialization. ZERO
 * transition/gate/Lead/time decision logic here — the service layer
 * remains the sole authority. NO billing/QC/BAST/payment/FM handler.
 *
 * Response serialization is BOUNDED: session identity fields, frozen
 * status and server timestamps, plus the recorded event metadata.
 * helper snapshots expose worker/user ids only (presence evidence —
 * NEVER billable manpower).
 */

const p = (v: string | string[] | undefined) =>
  (Array.isArray(v) ? v[0] : v) ?? '';

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

type SessionPayload = {
  id: string;
  executionScopeId: string;
  status: string;
  checkedInAt: string;
  startedWorkAt: string | null;
  completedAt: string | null;
  checkedOutAt: string | null;
};

type EventPayload = {
  id: string;
  eventType: string;
  occurredAt: string;
  idempotencyKey: string;
};

type HelperPresencePayload = {
  id: string;
  eventId: string;
  helperWorkerId: string;
  helperUserId: string | null;
  createdAt: string;
};

function toSessionPayload(s: HandymanWorkSessionRecord): SessionPayload {
  return {
    id: s.id,
    executionScopeId: s.executionScopeId,
    status: s.status,
    checkedInAt: s.checkedInAt.toISOString(),
    startedWorkAt: s.startedWorkAt?.toISOString() ?? null,
    completedAt: s.completedAt?.toISOString() ?? null,
    checkedOutAt: s.checkedOutAt?.toISOString() ?? null,
  };
}

function toEventPayload(e: HandymanWorkSessionEventRecord): EventPayload {
  return {
    id: e.id,
    eventType: e.eventType,
    occurredAt: e.occurredAt.toISOString(),
    idempotencyKey: e.idempotencyKey,
  };
}

function toHelperPayload(
  h: { id: string; eventId: string; helperWorkerId: string;
    helperUserId: string | null; createdAt: Date },
): HelperPresencePayload {
  return {
    id: h.id,
    eventId: h.eventId,
    helperWorkerId: h.helperWorkerId,
    helperUserId: h.helperUserId,
    createdAt: h.createdAt.toISOString(),
  };
}

function toCommandPayload(result: HandymanWorkSessionWorkClockResult) {
  return {
    session: toSessionPayload(result.session),
    event: toEventPayload(result.event),
    replayed: result.replayed,
  };
}

function toActivePayload(result: HandymanWorkSessionActiveResult) {
  return {
    session: toSessionPayload(result.session),
    helperPresence: result.helperPresence.map(toHelperPayload),
  };
}

function toProjectionPayload(
  p: HandymanWorkSessionTimeProjection,
) {
  return {
    sessionId: p.sessionId,
    executionScopeId: p.executionScopeId,
    status: p.status,
    presenceSeconds: p.presenceSeconds,
    actualWorkSeconds: p.actualWorkSeconds,
    sessionClosed: p.sessionClosed,
    projectedAt: p.projectedAt.toISOString(),
  };
}

function toCustomerCareWorkSessionItemPayload(
  item: HandymanCustomerCareWorkSessionItem,
) {
  return {
    ...toSessionPayload(item.session),
    events: item.events.map(toEventPayload),
    helperPresence: item.helperPresence.map(toHelperPayload),
    presenceSeconds: item.presenceSeconds,
    actualWorkSeconds: item.actualWorkSeconds,
    sessionClosed: item.sessionClosed,
    projectedAt: item.projectedAt.toISOString(),
  };
}

function toCustomerCareWorkSessionsPayload(
  p: HandymanCustomerCareWorkSessionsProjection,
) {
  return {
    executionScopeId: p.executionScopeId,
    activeSession: p.activeSession
      ? toCustomerCareWorkSessionItemPayload(p.activeSession)
      : null,
    sessions: p.sessions.map(toCustomerCareWorkSessionItemPayload),
    presenceSeconds: p.presenceSeconds,
    actualWorkSeconds: p.actualWorkSeconds,
    projectedAt: p.projectedAt.toISOString(),
  };
}

/** Shared thin mutation pipeline: parse → service → serialize. */
async function runMutation(
  req: Request,
  res: Response,
  next: NextFunction,
  command: (
    input: { executionScopeId: string; idempotencyKey: string },
    actorUserId: string,
  ) => Promise<HandymanWorkSessionWorkClockResult>,
): Promise<void> {
  try {
    const executionScopeId = parseWorkSessionScopeParam(
      p(req.params.executionScopeId),
    );
    const { idempotencyKey } = parseWorkSessionMutationBody(req.body);
    sendSuccess(
      res,
      toCommandPayload(await command(
        { executionScopeId, idempotencyKey },
        actor(req),
      )),
      200,
    );
  } catch (error) {
    next(error);
  }
}

export function postHandymanWorkSessionCheckInHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runMutation(req, res, next, checkInHandymanWorkSession);
}

export function postHandymanWorkSessionStartWorkHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runMutation(req, res, next, startWorkHandymanWorkSession);
}

export function postHandymanWorkSessionPauseHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runMutation(req, res, next, pauseHandymanWorkSession);
}

export function postHandymanWorkSessionMaterialRunHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runMutation(req, res, next, materialRunHandymanWorkSession);
}

export function postHandymanWorkSessionResumeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runMutation(req, res, next, resumeHandymanWorkSession);
}

export function postHandymanWorkSessionCompleteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runMutation(req, res, next, completeHandymanWorkSession);
}

export function postHandymanWorkSessionCheckOutHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  return runMutation(req, res, next, checkOutHandymanWorkSession);
}

/** GET active session + helper presence snapshot for the scope. */
export async function getHandymanWorkSessionActiveHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseWorkSessionScopeParam(
      p(req.params.executionScopeId),
    );
    sendSuccess(
      res,
      toActivePayload(await getActiveHandymanWorkSession(
        executionScopeId,
        actor(req),
      )),
      200,
    );
  } catch (error) {
    next(error);
  }
}

/**
 * CR-HM-17 GAP PART 03 — GET Customer Care work sessions projection
 * (active + CHECKED_OUT sessions, events, helper presence, and
 * presenceSeconds + actualWorkSeconds) for the execution scope.
 */
export async function getHandymanWorkSessionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const executionScopeId = parseWorkSessionScopeParam(
      p(req.params.executionScopeId),
    );
    sendSuccess(
      res,
      toCustomerCareWorkSessionsPayload(
        await getHandymanWorkSessionsCustomerCareView(
          executionScopeId,
          actor(req),
        ),
      ),
      200,
    );
  } catch (error) {
    next(error);
  }
}

/** GET internal read-only presence/actual-work projection. */
export async function getHandymanWorkSessionTimeProjectionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sessionId = parseWorkSessionIdParam(
      p(req.params.sessionId),
    );
    const actorUserId = actor(req);
    const session = await handymanWorkSessionRepository
      .findWorkSessionById(undefined, sessionId);
    if (!session) throw handymanWorkSessionNotFoundError();
    sendSuccess(
      res,
      toProjectionPayload(
        await getHandymanWorkSessionTimeProjection(
          session.executionScopeId,
          actorUserId,
        ),
      ),
      200,
    );
  } catch (error) {
    next(error);
  }
}

import type { NextFunction, Request, Response } from 'express';
import { sendSuccess } from '../../shared/api-response';
import { authenticationRequiredError } from '../auth';
import {
  listHandymanVisitArrivalsByVisit,
  recordAssistedHandymanVisitArrival,
  recordGpsHandymanVisitArrival,
} from './handyman-visit-arrival.service';
import {
  getHandymanVisitExecutionPresence,
  recordAssistedHandymanVisitPresence,
  recordHandymanVisitPresenceByLead,
} from './handyman-visit-presence.service';
import {
  endHandymanWorkSession,
  getHandymanWorkSessionById,
  listHandymanWorkSessionsByVisit,
  startHandymanWorkSession,
} from './handyman-work-session.service';
import { parseHandymanServiceVisitIdParam } from './handyman-service-visit.validation';
import {
  assertEmptyEndWorkSessionHttpBody,
  parseAssistedArrivalHttpBody,
  parseAssistedPresenceHttpBody,
  parseGpsArrivalHttpBody,
  parseHandymanWorkSessionIdParam,
  parsePresenceByLeadHttpBody,
  parseStartWorkSessionHttpBody,
} from './handyman-field-execution.validation';

/**
 * CR-HM-BE-06 RUN 3 — Thin HTTP handlers for the field-execution surface
 * (visit arrival, crew presence, work session). ALL authority lives in the
 * Run-1/Run-2 services: GPS verification against the backend-authoritative
 * building configuration, the one-VERIFIED-arrival invariant, the frozen
 * presence snapshot, lead-chain resolution, the guarded execution start
 * (verified arrival + Lead PRESENT + BE-05 readiness + vendor_work-before-
 * Work-Order convergence) and the replay-safe end. These handlers ONLY
 * parse governed inputs, derive the actor from the authenticated session
 * (NEVER from the body — no mass assignment, no caller-supplied client
 * scope) and delegate. No lifecycle, readiness, lead/crew or arrival
 * authority is decided here, and no domain conflict is ever converted into
 * a transport error: failures flow to the shared Express error pipeline via
 * `next(error)` with their domain codes and statuses intact (including the
 * 409 HANDYMAN_WORK_SESSION_EXECUTION_STATE_INCONSISTENT inconsistency
 * fact).
 *
 * Status codes: command endpoints that ESTABLISH a new fact answer 201;
 * an idempotent replay/convergence onto the existing authoritative fact
 * answers 200 with `converged: true`. Presence marks and the session end
 * update/close existing facts and always answer 200.
 */

function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function actor(req: Request): string {
  if (!req.auth) throw authenticationRequiredError();
  return req.auth.userId;
}

export async function recordGpsHandymanVisitArrivalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const body = parseGpsArrivalHttpBody(req.body);
    const result = await recordGpsHandymanVisitArrival(
      visitId,
      body,
      actor(req),
    );
    sendSuccess(res, result, result.converged ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function recordAssistedHandymanVisitArrivalHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const body = parseAssistedArrivalHttpBody(req.body);
    const result = await recordAssistedHandymanVisitArrival(
      visitId,
      body,
      actor(req),
    );
    sendSuccess(res, result, result.converged ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanVisitArrivalsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const arrivals = await listHandymanVisitArrivalsByVisit(
      visitId,
      actor(req),
    );
    sendSuccess(res, arrivals);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanVisitPresenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const view = await getHandymanVisitExecutionPresence(visitId, actor(req));
    sendSuccess(res, view);
  } catch (error) {
    next(error);
  }
}

export async function recordHandymanVisitPresenceByLeadHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const body = parsePresenceByLeadHttpBody(req.body);
    const presence = await recordHandymanVisitPresenceByLead(
      visitId,
      body,
      actor(req),
    );
    sendSuccess(res, presence);
  } catch (error) {
    next(error);
  }
}

export async function recordAssistedHandymanVisitPresenceHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const body = parseAssistedPresenceHttpBody(req.body);
    const presence = await recordAssistedHandymanVisitPresence(
      visitId,
      body,
      actor(req),
    );
    sendSuccess(res, presence);
  } catch (error) {
    next(error);
  }
}

export async function startHandymanWorkSessionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const body = parseStartWorkSessionHttpBody(req.body);
    const result = await startHandymanWorkSession(visitId, body, actor(req));
    sendSuccess(res, result, result.converged ? 200 : 201);
  } catch (error) {
    next(error);
  }
}

export async function listHandymanWorkSessionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const visitId = parseHandymanServiceVisitIdParam(param(req.params.visitId));
    const sessions = await listHandymanWorkSessionsByVisit(
      visitId,
      actor(req),
    );
    sendSuccess(res, sessions);
  } catch (error) {
    next(error);
  }
}

export async function getHandymanWorkSessionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sessionId = parseHandymanWorkSessionIdParam(
      param(req.params.sessionId),
    );
    const session = await getHandymanWorkSessionById(sessionId, actor(req));
    sendSuccess(res, session);
  } catch (error) {
    next(error);
  }
}

export async function endHandymanWorkSessionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sessionId = parseHandymanWorkSessionIdParam(
      param(req.params.sessionId),
    );
    assertEmptyEndWorkSessionHttpBody(req.body);
    const result = await endHandymanWorkSession(sessionId, actor(req));
    sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * CR-BE-SAAS-01 PART 11B — Support session HTTP controllers
 * (frozen §22 / §19).
 *
 * Controllers perform:
 *   - request validation (body UUID / shape);
 *   - authenticated-actor binding (`req.auth.userId`);
 *   - delegation to the PART 11A domain service (no rule recoding);
 *   - canonical projection shaping for the response.
 *
 * Controllers do NOT:
 *   - accept `actorUserId` / `expiresAt` / `status` from the body;
 *   - re-implement business rules (max duration, scope, audit);
 *   - mutate state on GET reads;
 *   - audit reads.
 *
 * Routes are mounted by `createPlatformSupportRouter`.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors';
import { sendSuccess } from '../../shared/api-response';
import { getRequestId } from '../../shared/request-context';
import {
  openSupportSession,
  platformSupportSessionRepository,
  revokeSupportSession,
  type PlatformSupportSessionRecord,
} from './index';
import { parseOpenSupportSessionBody } from './platform-support-session.validation';

const SUPPORT_AUTHORITY = 'platform.support.access';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ensureUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a UUID.` },
    ]);
  }
  return value.toLowerCase();
}

export interface PlatformSupportSessionPublic {
  id: string;
  supportActorUserId: string;
  customerId: string;
  buildingId: string | null;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedByUserId: string | null;
  /**
   * `effective` is the DERIVED state per §19.2 rule 2:
   *   - "EFFECTIVE" — storage `ACTIVE` AND `expires_at` is in the future
   *   - "EXPIRED"   — storage `ACTIVE` AND `expires_at` is in the past
   *   - "REVOKED"   — storage `ENDED` (explicit revoke only)
   */
  effective: 'EFFECTIVE' | 'EXPIRED' | 'REVOKED';
  status: 'ACTIVE' | 'ENDED';
}

function toPublic(
  record: PlatformSupportSessionRecord,
  now: Date,
): PlatformSupportSessionPublic {
  let effective: 'EFFECTIVE' | 'EXPIRED' | 'REVOKED';
  if (record.status === 'ENDED') {
    effective = 'REVOKED';
  } else if (record.expiresAt.getTime() <= now.getTime()) {
    effective = 'EXPIRED';
  } else {
    effective = 'EFFECTIVE';
  }
  return {
    id: record.id,
    supportActorUserId: record.supportActorUserId,
    customerId: record.customerId,
    buildingId: record.buildingId,
    reason: record.reason,
    startedAt: record.startedAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    endedAt: record.endedAt ? record.endedAt.toISOString() : null,
    endedByUserId: record.endedByUserId,
    effective,
    status: record.status,
  };
}

/**
 * POST /api/v1/platform/support-sessions.
 *
 * Opens a new explicit support session for the authenticated actor.
 * Body is validated; actor is server-derived from `req.auth.userId`.
 */
export async function openSupportSessionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = parseOpenSupportSessionBody(req.body);
    const requestId = getRequestId() ?? undefined;
    const session = await openSupportSession({
      actorUserId: req.auth.userId,
      authority: SUPPORT_AUTHORITY,
      customerId: input.customerId,
      buildingId: input.buildingId ?? null,
      reason: input.reason,
      durationMinutes: input.durationMinutes,
      requestId,
    });
    sendSuccess(res, toPublic(session, new Date()), 201);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/platform/support-sessions.
 *
 * Lists support sessions visible to the authenticated platform
 * support actor (`platform.support.access`). Sessions are scoped to
 * the calling actor — a support actor cannot see another actor's
 * sessions through this list. Listing does not mutate state and
 * does not produce audit events.
 *
 * Frozen §22 row: "GET /platform/support-sessions — `active/expired,
 * filterable`" — only the optional `customerId` query is consistent
 * with the §17.4 platform-list pattern. EXPIRED rows are returned by
 * default (the §22 cell says "active/expired"). No pagination,
 * no extra filters are frozen for this endpoint in PART 11.
 */
export async function listSupportSessionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const q = req.query as Record<string, unknown>;
    const customerId =
      typeof q['customerId'] === 'string' && q['customerId'].length > 0
        ? ensureUuid(q['customerId'], 'customerId')
        : null;
    const records = await platformSupportSessionRepository.listForActor(
      req.auth.userId,
      null,
    );
    const filtered = records.filter((r) =>
      customerId ? r.customerId === customerId : true,
    );
    const now = new Date();
    const projected = filtered.map((r) => toPublic(r, now));
    // Canonical envelope: sendSuccess(res, array) → `{success:true,
    // data: [...], meta:{}}`.
    sendSuccess(res, projected, 200);
  } catch (error) {
    next(error);
  }
}

/**
 * DELETE /api/v1/platform/support-sessions/:id.
 *
 * Explicit revoke of an ACTIVE session. Calls the PART 11A
 * `revokeSupportSession` service which produces the
 * `SAAS_SUPPORT_ACCESS_ENDED` audit inside the same transaction.
 * Idempotent at the row layer — repeat DELETE on an already ENDED
 * row returns 200 with `{revoked: false}` (no extra audit).
 */
export async function revokeSupportSessionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const sessionId = ensureUuid(req.params['id'], 'id');
    const requestId = getRequestId() ?? undefined;
    const result = await revokeSupportSession({
      sessionId,
      actorUserId: req.auth.userId,
      authority: SUPPORT_AUTHORITY,
      requestId,
    });
    const status = result.revoked ? 200 : 200;
    sendSuccess(
      res,
      {
        revoked: result.revoked,
        session: result.session ? toPublic(result.session, new Date()) : null,
      },
      status,
    );
  } catch (error) {
    next(error);
  }
}

/* The runtime enforcement seam lives in `runtime-guard.ts` and is
 * exported via `index.ts` for use by future PART 11+ enforcement
 * call sites that the contract may freeze later. It is not exposed
 * as a §22 row in PART 11B (no `GET /platform/support-sessions/:id/
 * effectiveness` route). PART 11C is reserved for final validation
 * and commit. */

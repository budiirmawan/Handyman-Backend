import { AppError, ERROR_CODES } from '../../shared/errors';
import {
  checkSupportSessionEffectiveness,
  type PlatformSupportSessionRecord,
  type SupportSessionEffectiveness,
} from './index';

/**
 * Frozen error code strings (§17.1 catalogue + §19.2 rule 2).
 * Re-exported through the module index so downstream seams and
 * tests reference a single source.
 */
export const SAAS_SUPPORT_SESSION_EXPIRED =
  ERROR_CODES.SAAS_SUPPORT_SESSION_EXPIRED;
export const SAAS_SUPPORT_SESSION_NOT_FOUND =
  ERROR_CODES.SAAS_SUPPORT_SESSION_NOT_FOUND;

/**
 * CR-BE-SAAS-01 PART 11B — Support-context runtime enforcement seam
 * (frozen §19.2 rule 5 — "platform-console visibility into the
 * customer's context only").
 *
 * This is the canonical, reusable entry point that future PART 11+
 * features (data-access joins, scoped dashboards, etc.) MUST funnel
 * through before they touch business-plane data on behalf of a
 * support session. Concrete responsibilities:
 *
 *   1. Bind the support actor's `userId` to the session's
 *      `supportActorUserId` (frozen §19.2 rule 3 — no impersonation
 *      and no cross-actor use of a session).
 *   2. Confirm the session is `EFFECTIVE` right now (active AND not
 *      past `expires_at`). EXPIRED → 403 SAAS_SUPPORT_SESSION_EXPIRED
 *      (frozen §19.2 rule 2).
 *   3. Re-check customer scope (`session.customerId === requested`).
 *   4. Re-check building scope (PART 11A ownership rules via the
 *      service's `checkSupportSessionEffectiveness`).
 *   5. Refuse to bypass §12.2 suspended-access policy (PART 11A never
 *      does; this seam does not introduce a bypass either).
 *
 * The seam NEVER mints support authority from `platform.support.access`
 * alone — `platform.support.access` only governs the management surface
 * (POST/GET/DELETE). It does NOT silently grant access to any
 * business-plane endpoint.
 *
 * Errors thrown here use FROZEN error codes from the §17.1 catalogue:
 *   - `SAAS_SUPPORT_SESSION_EXPIRED` (frozen §19.2 rule 2) — for a
 *     session whose `expires_at` has passed.
 *   - `SAAS_SUPPORT_SESSION_NOT_FOUND` (frozen §17.1 catalogue) —
 *     for missing, cross-actor, cross-customer, cross-building,
 *     cross-owner, or explicitly-revoked sessions. We collapse these
 *     to a single NOT_FOUND surface so the seam never leaks whether
 *     an unrelated session exists.
 */

export interface SupportContextParams {
  /** The authenticated user invoking a support-scoped operation. */
  actorUserId: string;
  /** The support session id being relied on. */
  sessionId: string;
  /** Target customer the caller is asking about. */
  customerId: string;
  /** Optional narrowed building within that customer. */
  buildingId?: string | null;
}

export interface EffectiveSupportContext {
  session: PlatformSupportSessionRecord;
  actorUserId: string;
  customerId: string;
  buildingId: string | null;
}

/**
 * Throws if the support context is not EFFECTIVE for the requested
 * scope. Returns the bound session on success. Reusable from any
 * future business-plane read/write that is explicitly tagged as
 * "support-scoped" in the contract.
 */
export async function assertSupportContextEffectiveness(
  params: SupportContextParams,
): Promise<EffectiveSupportContext> {
  if (!params.actorUserId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'actorUserId', message: 'actorUserId is mandatory.' },
    ]);
  }
  if (!params.sessionId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'sessionId', message: 'sessionId is mandatory.' },
    ]);
  }
  if (!params.customerId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'customerId', message: 'customerId is mandatory.' },
    ]);
  }
  // 1. Effectiveness check (rows + scope + ownership) is delegated to
  //    the PART 11A canonical liveness check.
  const result: SupportSessionEffectiveness =
    await checkSupportSessionEffectiveness({
      sessionId: params.sessionId,
      customerId: params.customerId,
      buildingId: params.buildingId ?? null,
    });
  if (result.kind === 'EFFECTIVE') {
    // 2. Actor binding (no impersonation, no cross-actor use).
    if (result.session.supportActorUserId !== params.actorUserId) {
      // Collapse to the same NOT_FOUND surface so we never leak
      // whether an unrelated session exists.
      throw new AppError({
        code: ERROR_CODES.SAAS_SUPPORT_SESSION_NOT_FOUND,
        message:
          'Support session was not found for the calling actor and scope.',
        statusCode: 404,
      });
    }
    return {
      session: result.session,
      actorUserId: params.actorUserId,
      customerId: params.customerId,
      buildingId: result.session.buildingId,
    };
  }
  if (result.kind === 'EXPIRED') {
    throw new AppError({
      code: ERROR_CODES.SAAS_SUPPORT_SESSION_EXPIRED,
      message: 'Support session has expired.',
      statusCode: 403,
    });
  }
  // REVOKED or NOT_FOUND (missing, cross-customer, cross-building,
  // cross-owner). All collapse to the frozen NOT_FOUND surface.
  throw new AppError({
    code: ERROR_CODES.SAAS_SUPPORT_SESSION_NOT_FOUND,
    message:
      'Support session was not found, does not match the requested scope, or has been revoked.',
    statusCode: 404,
  });
}

/**
 * Public read-only check (does NOT throw) for controllers that need
 * a derived effective/expired/revoked state without auditing. Used by
 * the GET listing projection.
 */
export async function readSupportContextEffectiveness(
  params: SupportContextParams,
): Promise<SupportSessionEffectiveness> {
  return checkSupportSessionEffectiveness({
    sessionId: params.sessionId,
    customerId: params.customerId,
    buildingId: params.buildingId ?? null,
  });
}

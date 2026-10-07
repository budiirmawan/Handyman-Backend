import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { withTransaction } from '../../database';
import { recordOperationalEvent } from '../operational-events';
import { platformSupportSessionRepository } from './platform-support-session.repository';
import {
  SUPPORT_ACCESS_ENDED,
  SUPPORT_ACCESS_STARTED,
  SUPPORT_SESSION_ENTITY_TYPE,
  type OpenSupportSessionInput,
  type PlatformSupportSessionRecord,
  type SupportSessionEffectiveness,
} from './platform-support-session.types';

/**
 * CR-BE-SAAS-01 PART 11 — Support Access Core service (frozen §19).
 *
 * PART 11A scope: domain-only. No HTTP, no auth, no idempotency-key.
 * The controller / route layer (PART 11B) wraps these functions
 * behind `requirePlatformPermission('platform.support.access')`.
 *
 * PART 11 invariants (§19.2):
 *   1. Reason is mandatory and non-empty.
 *   2. `durationMinutes` is REJECTED if it exceeds the
 *      platform-configured maximum (frozen §19.2 rule 1 says
 *      "durationMinutes ≤ platform-configured maximum, default 480").
 *      PART 11A does NOT clamp — oversize is a 400 validation error.
 *      PART 12 will replace the constant with the real
 *      `saas.support_session_max_minutes` lookup; PART 11A uses the
 *      frozen default.
 *   3. `expires_at` is server-authoritative (NOW() + duration minutes).
 *   4. Expiry is effective on read — no cron needed. Expired sessions
 *      remain in storage as status='ACTIVE' but their `expires_at` is
 *      in the past. The reopen rule (§19.1 "unique effective session
 *      per (actor, customer)") explicitly allows a NEW session to
 *      coexist with an expired-but-still-'ACTIVE' row.
 *   5. Revocation is immediate and audited.
 *   6. Audits use `recordOperationalEvent(..., client)` inside the
 *      same transaction; metadata carries supportSessionId.
 *   7. Only the grant/start and revoke events are audited. Expiry is
 *      derived on read (§18.2 has no `EXPIRED` event).
 *   8. No impersonation. Audit always carries the real `actor_user_id`.
 *   9. Cross-customer isolation: each session is scoped to one
 *      customerId; liveness checks refuse other customers.
 *  10. Building scope (when set): the session applies ONLY to that
 *      building. The opening call verifies the building exists and its
 *      property belongs to the target customer; liveness checks
 *      require the requested building to match the session's
 *      `building_id` exactly. A `building_id = null` session is
 *      customer-wide (no further narrowing).
 *  11. PLATFORM_ADMIN without explicit `platform.support.access` grant
 *      is denied at the route layer (§22, frozen D2); the service
 *      assumes the caller has already passed `requirePlatformPermission`.
 */

/**
 * Default maximum for `saas.support_session_max_minutes` when
 * `platform_configurations` has no row OR a malformed value. Mirrors
 * the frozen §20.2 default.
 */
const SAAS_SUPPORT_SESSION_MAX_MINUTES_DEFAULT = 480;

/**
 * Resolve the active max-minutes cap from `platform_configurations`.
 * Falls back to the frozen default when the key is absent or malformed
 * (matching the PART 08 `readConfigNumber` convention). This is the
 * authoritative source — there is no other source for this cap.
 */
async function resolveSupportMaxMinutes(): Promise<number> {
  const configured =
    await platformSupportSessionRepository.readMaxMinutes();
  if (configured !== null && configured !== undefined) return configured;
  return SAAS_SUPPORT_SESSION_MAX_MINUTES_DEFAULT;
}

function reasonViolations(reason: string): { field: string; message: string }[] {
  const trimmed = (reason ?? '').trim();
  if (!trimmed) {
    return [{ field: 'reason', message: 'reason is mandatory.' }];
  }
  if (trimmed.length > 500) {
    return [
      { field: 'reason', message: 'reason must be at most 500 characters.' },
    ];
  }
  return [];
}

function durationViolations(
  durationMinutes: number,
  maxMinutes: number,
): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (
    !Number.isInteger(durationMinutes) ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0
  ) {
    errors.push({
      field: 'durationMinutes',
      message: 'durationMinutes must be a positive integer.',
    });
    return errors;
  }
  // Frozen rule (§19.2 rule 1): "durationMinutes ≤
  // platform-configured maximum, default 480". Oversize → REJECT 400,
  // not clamp. `maxMinutes` is the configuration-resolved value (or
  // the default 480 fallback), never an invented value.
  if (durationMinutes > maxMinutes) {
    errors.push({
      field: 'durationMinutes',
      message: `durationMinutes exceeds the platform-configured maximum of ${maxMinutes}.`,
    });
  }
  return errors;
}

function validate(
  input: OpenSupportSessionInput,
  maxMinutes: number,
): void {
  const errors = [
    ...reasonViolations(input.reason),
    ...durationViolations(input.durationMinutes, maxMinutes),
  ];
  if (!input.customerId) {
    errors.push({ field: 'customerId', message: 'customerId is mandatory.' });
  }
  if (!input.actorUserId) {
    errors.push({ field: 'actorUserId', message: 'actorUserId is mandatory.' });
  }
  if (errors.length > 0) {
    throw AppError.validation('Request validation failed.', errors);
  }
}

function computeExpiresAt(durationMinutes: number, now: Date): Date {
  return new Date(now.getTime() + durationMinutes * 60_000);
}

/**
 * Hash `(actorUserId, customerId)` into a 63-bit signed-integer string
 * for `pg_advisory_xact_lock`. We use a deterministic DJB2-like fold
 * over the concatenated string — collisions are statistically
 * negligible across a single support tenant, and a false-collision only
 * inflates contention (does not introduce data corruption).
 */
function hashLockKey(actorUserId: string, customerId: string): string {
  const combined = `${actorUserId}\u0000${customerId}`;
  let h = 0n;
  for (let i = 0; i < combined.length; i++) {
    h = (h * 1_000_003n) + BigInt(combined.charCodeAt(i));
  }
  // Mask to signed 63-bit so it fits pg int8 (advisory lock takes bigint).
  return (h & ((1n << 63n) - 1n)).toString();
}

export async function openSupportSession(
  input: OpenSupportSessionInput,
): Promise<PlatformSupportSessionRecord> {
  // 0. Resolve the authoritative max-minutes cap from
  //    `platform_configurations` (fallback: §19.2/§20.2 default 480).
  //    Read the config BEFORE take-the-lock so an obviously bad
  //    durationMinutes short-circuits before we serialise.
  const maxMinutes = await resolveSupportMaxMinutes();
  validate(input, maxMinutes);

  // 1. Verify optional building scope belongs to the target customer
  //    BEFORE taking the advisory lock. Building-scope check is a
  //    plain SELECT (no need to be in the same transaction as the
  //    INSERT).
  if (input.buildingId) {
    const ownerClientId =
      await platformSupportSessionRepository.findBuildingClientId(
        input.buildingId,
      );
    if (!ownerClientId) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'buildingId',
          message: 'buildingId does not exist or is not ACTIVE.',
        },
      ]);
    }
    if (ownerClientId !== input.customerId) {
      throw AppError.validation('Request validation failed.', [
        {
          field: 'buildingId',
          message:
            'buildingId does not belong to the target customer (cross-customer scope rejected).',
        },
      ]);
    }
  }

  // 2. INSERT + audit inside one transaction. The advisory lock at
  //    the (actor, customer) boundary serialises concurrent opens
  //    so we cannot violate the unique-effective-session invariant.
  const lockKey = hashLockKey(input.actorUserId, input.customerId);
  const now = new Date();
  const expiresAt = computeExpiresAt(input.durationMinutes, now);

  try {
    return await withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockKey]);
      // Re-check inside the lock — at most one EFFECTIVE row.
      const existing =
        await platformSupportSessionRepository.findEffectiveByActorCustomer(
          input.actorUserId,
          input.customerId,
          new Date(),
          client,
        );
      if (existing) {
        throw new AppError({
          code: ERROR_CODES.CONFLICT,
          message:
            'An effective support session already exists for this actor and customer.',
          statusCode: 409,
        });
      }
      const inserted = await platformSupportSessionRepository.insert(
        {
          supportActorUserId: input.actorUserId,
          customerId: input.customerId,
          buildingId: input.buildingId ?? null,
          reason: input.reason.trim(),
          startedAt: now,
          expiresAt,
        },
        client,
      );
      await recordOperationalEvent(
        {
          clientId: input.customerId,
          eventType: SUPPORT_ACCESS_STARTED,
          entityType: SUPPORT_SESSION_ENTITY_TYPE,
          entityId: inserted.id,
          actorUserId: input.actorUserId,
          buildingId: input.buildingId ?? null,
          summary: `Support access opened for customer ${input.customerId}`,
          metadata: {
            authority: input.authority,
            reason: inserted.reason,
            expiresAt: inserted.expiresAt.toISOString(),
            buildingId: inserted.buildingId,
            durationMinutes: input.durationMinutes,
            supportSessionId: inserted.id,
            requestId: input.requestId ?? null,
          },
        },
        client as PoolClient,
      );
      return inserted;
    });
  } catch (err) {
    // Map DB-level concurrency violations (e.g. a unique-index
    // collision that does not exist anymore — keep this in case a
    // future migration re-introduces one) to the same 409.
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === '23505'
    ) {
      throw new AppError({
        code: ERROR_CODES.CONFLICT,
        message:
          'An effective support session already exists for this actor and customer.',
        statusCode: 409,
      });
    }
    throw err;
  }
}

export async function revokeSupportSession(params: {
  sessionId: string;
  actorUserId: string;
  authority: string;
  requestId?: string;
}): Promise<{ revoked: boolean; session?: PlatformSupportSessionRecord }> {
  if (!params.sessionId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'sessionId', message: 'sessionId is mandatory.' },
    ]);
  }
  if (!params.actorUserId) {
    throw AppError.validation('Request validation failed.', [
      { field: 'actorUserId', message: 'actorUserId is mandatory.' },
    ]);
  }
  // PART 13B hardening: row UPDATE + audit commit atomically. An
  // already-ENDED session is the row-level idempotent replay — no
  // audit is staged (rule E: idempotent replay must NOT create
  // duplicate audit rows).
  return withTransaction(async (txClient) => {
    const before = await platformSupportSessionRepository.findById(
      params.sessionId,
      txClient,
    );
    if (!before) {
      throw new AppError({
        code: 'NOT_FOUND',
        message: 'Support session not found.',
        statusCode: 404,
      });
    }
    if (before.status === 'ENDED') {
      // Idempotent replay — return without staging any audit.
      return { revoked: false, session: before };
    }
    const { updated } = await platformSupportSessionRepository.markEnded(
      params.sessionId,
      params.actorUserId,
      txClient,
    );
    if (!updated) {
      const after = await platformSupportSessionRepository.findById(
        params.sessionId,
        txClient,
      );
      return { revoked: false, session: after ?? before };
    }
    const after = await platformSupportSessionRepository.findById(
      params.sessionId,
      txClient,
    );
    await recordOperationalEvent(
      {
        clientId: before.customerId,
        eventType: SUPPORT_ACCESS_ENDED,
        entityType: SUPPORT_SESSION_ENTITY_TYPE,
        entityId: before.id,
        actorUserId: params.actorUserId,
        buildingId: before.buildingId,
        summary: `Support access ended for customer ${before.customerId}`,
        metadata: {
          authority: params.authority,
          before: {
            status: before.status,
            expiresAt: before.expiresAt.toISOString(),
          },
          after: after
            ? {
                status: after.status,
                endedAt: after.endedAt?.toISOString() ?? null,
              }
            : null,
          reason: before.reason,
          expiresAt: before.expiresAt.toISOString(),
          buildingId: before.buildingId,
          supportSessionId: before.id,
          requestId: params.requestId ?? null,
        },
      },
      txClient,
    );
    return { revoked: true, session: after ?? before };
  });
}

/**
 * Liveness check at use (§19.2 rule 2). Derived on read — the stored
 * status is `ACTIVE` but effective status returns `EXPIRED` when
 * `expires_at <= now`. Used by downstream PART 11B enforcement.
 *
 * Cross-customer isolation: refuses mismatched `customerId`.
 *
 * Building scope enforcement (§19 frozen):
 *   - session.buildingId is non-null
 *       → requested buildingId MUST equal it. Building ownership
 *         (canonical chain buildings → properties → clients) MUST
 *         resolve to session.customerId.
 *   - session.buildingId is null (customer-wide):
 *       - no requested buildingId         → EFFECTIVE.
 *       - requested buildingId supplied   → resolve canonical
 *         ownership; the building MUST belong to session.customerId.
 *         A cross-customer building on a customer-wide session is
 *         treated as scope-denial (NOT_FOUND), never silently
 *         accepted.
 */
export async function checkSupportSessionEffectiveness(params: {
  sessionId: string;
  customerId: string;
  /** Optional narrowed buildingId the caller is asking about. */
  buildingId?: string | null;
  now?: Date;
}): Promise<SupportSessionEffectiveness> {
  const now = params.now ?? new Date();
  const session = await platformSupportSessionRepository.findById(params.sessionId);
  if (!session) return { kind: 'NOT_FOUND' };
  if (session.customerId !== params.customerId) {
    // §19.2 rule 5: never silently allow cross-customer access.
    return { kind: 'NOT_FOUND' };
  }
  if (session.status === 'ENDED') {
    return { kind: 'REVOKED', session };
  }

  // Building-scope enforcement.
  if (session.buildingId !== null) {
    // Building-scoped session → EXACT match required.
    if (!params.buildingId || params.buildingId !== session.buildingId) {
      return { kind: 'NOT_FOUND' };
    }
    // And confirm ownership via the canonical chain (frozen).
    const ownerClientId =
      await platformSupportSessionRepository.findBuildingClientId(
        params.buildingId,
      );
    if (!ownerClientId || ownerClientId !== session.customerId) {
      return { kind: 'NOT_FOUND' };
    }
  } else {
    // Customer-wide session: when a buildingId IS supplied, the
    // building must belong to this customer. Without a supplied
    // buildingId, the session is the full customer scope.
    if (params.buildingId) {
      const ownerClientId =
        await platformSupportSessionRepository.findBuildingClientId(
          params.buildingId,
        );
      if (!ownerClientId || ownerClientId !== session.customerId) {
        // Cross-customer building on a customer-wide session →
        // scope-denial NOT_FOUND.
        return { kind: 'NOT_FOUND' };
      }
    }
  }

  // ACTIVE row; check expiry.
  if (session.expiresAt.getTime() <= now.getTime()) {
    return { kind: 'EXPIRED', session };
  }
  return { kind: 'EFFECTIVE', session };
}

/**
 * Default constant exposed for tests / diagnostics. The value mirrors
 * §20.2 `saas.support_session_max_minutes` (default 480).
 */
export const SAAS_SUPPORT_SESSION_MAX_MINUTES = SAAS_SUPPORT_SESSION_MAX_MINUTES_DEFAULT;

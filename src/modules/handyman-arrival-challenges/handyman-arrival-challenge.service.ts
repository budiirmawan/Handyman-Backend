import type { PoolClient } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { getPool, withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { generateSessionToken, hashSessionToken } from '../auth/session.token';
import { handymanExecutionScopeNotFoundError } from '../handyman-quotations';
import {
  handymanScopeAssignmentRepository,
  resolveHandymanAssignmentLead,
} from '../handyman-scope-assignments';
import {
  arrivalChallengeInvalidError,
  arrivalChallengeLiveConflictError,
  arrivalChallengeNotAuthorizedError,
  arrivalChallengeNotFoundError,
  arrivalChallengeScopeNotAuthorizedError,
} from './handyman-arrival-challenge.errors';
import { handymanArrivalChallengeRepository }
  from './handyman-arrival-challenge.repository';
import type {
  ConsumeHandymanArrivalChallengeInput,
  CreateHandymanArrivalChallengeInput,
  HandymanArrivalChallengeCreateResult,
  HandymanArrivalChallengeRecord,
  PublicHandymanArrivalChallenge,
} from './handyman-arrival-challenge.types';
import { HANDYMAN_ARRIVAL_CHALLENGE_TTL_SECONDS }
  from './handyman-arrival-challenge.types';

/**
 * CR-HM-07 Arrival Verification PART 01 — server-authoritative
 * arrival challenge foundation (FROZEN governance §F + CR-HM-04
 * activation certification consumer contract §5/§6).
 *
 * Authority flow (server-only): executionScopeId → AUTHORIZED scope
 * (CR-HM-06, read-only) → Client realm access → ACTIVE assignment →
 * CR-HM-04 authoritative Lead resolver → actor MUST equal the
 * authoritative leadUserId. Helpers/non-Lead users can never create
 * or consume. Caller never supplies workerId/crewId/leadUserId/
 * clientId/expected-location/status/TTL — whitelisted input surface
 * is exactly { executionScopeId } (creation) and
 * { challengeId, token } (consumption).
 *
 * Semantics: PENDING (issued, DB clock NOW()+120s) → CONSUMED
 * (single use) or EXPIRED (server TTL projection). CONSUMED is NOT
 * an arrival VERIFIED result; no outcome model exists in PART 01.
 * NO QR/location-token, NO GPS/geofence, NO work-session, NO
 * attendance, NO scheduling, NO payment/BAST, NO FM patrol/work_order
 * runtime. No HTTP/OpenAPI (PART 02+).
 */

function ensureUuid(value: string, field: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isValidUuid(raw)) {
    throw new Error(`HANDYMAN_ARRIVAL_CHALLENGE_INVALID_UUID:${field}`);
  }
  return raw;
}

function toPublic(
  record: HandymanArrivalChallengeRecord,
): PublicHandymanArrivalChallenge {
  return {
    id: record.id,
    clientId: record.clientId,
    executionScopeId: record.executionScopeId,
    assignmentId: record.assignmentId,
    actorUserId: record.actorUserId,
    status: record.status,
    expiresAt: record.expiresAt.toISOString(),
    consumedAt: record.consumedAt ? record.consumedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** Audit-only journal; the challenge table remains the authority. */
async function journal(
  tx: Pick<PoolClient, 'query'>,
  record: HandymanArrivalChallengeRecord,
  eventType: string,
  summary: string,
): Promise<void> {
  await recordOperationalEvent(
    {
      clientId: record.clientId,
      eventType,
      entityType: 'HANDYMAN_ARRIVAL_CHALLENGE',
      entityId: record.id,
      actorUserId: record.actorUserId,
      summary,
      metadata: {
        challengeId: record.id,
        executionScopeId: record.executionScopeId,
        assignmentId: record.assignmentId,
        status: record.status,
        expiresAt: record.expiresAt.toISOString(),
        // token material is NEVER journaled.
      },
    },
    tx,
  );
}

/**
 * Postgres unique-violation mapped to the ONE bounded live-conflict
 * behavior (no retry loop, no second live row, no silent return of
 * someone else's challenge).
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: string }).code === '23505'
  );
}

/**
 * Create an arrival challenge. Returns the PUBLIC record exactly
 * once with the RAW token; only the SHA-256 hash is persisted.
 *
 * Precondition chain (all server-verified): scope exists → scope
 * AUTHORIZED → actor has Client access → ACTIVE assignment exists →
 * actor == authoritative Lead userId (CR-HM-04 resolver; a Lead that
 * went invalid after assignment fails closed via LEAD_INVALID).
 */
export async function createHandymanArrivalChallenge(
  input: CreateHandymanArrivalChallengeInput,
  actorUserId: string,
): Promise<HandymanArrivalChallengeCreateResult> {
  const executionScopeId = ensureUuid(
    input.executionScopeId,
    'executionScopeId',
  );
  ensureUuid(actorUserId, 'actorUserId');

  const scope = await handymanScopeAssignmentRepository.findScopeById(
    undefined,
    executionScopeId,
  );
  if (!scope) throw handymanExecutionScopeNotFoundError();
  if (scope.status !== 'AUTHORIZED') {
    throw arrivalChallengeScopeNotAuthorizedError();
  }
  if (!(await contextAccessService.canAccessClient(
    actorUserId, scope.clientId,
  ))) {
    throw buildingAccessDeniedError();
  }
  // Sole authoritative Lead: CR-HM-04 bounded resolver (re-validates
  // the ACTIVE assignment and its CURRENT Lead validity chain).
  const resolution = await resolveHandymanAssignmentLead(
    executionScopeId,
    actorUserId,
  );
  if (!resolution || resolution.leadUserId !== actorUserId) {
    throw arrivalChallengeNotAuthorizedError();
  }

  // Raw token: existing server-side secure-random convention; hash at
  // rest; raw value crosses exactly THIS boundary once.
  const token = generateSessionToken(32);
  const tokenHash = hashSessionToken(token);

  return withTransaction(async (tx) => {
    // Server-clock TTL projection first (any stale PENDING expires).
    const stale = await handymanArrivalChallengeRepository
      .expireStaleForScopeActor(tx, executionScopeId, actorUserId);
    for (const row of stale) {
      await journal(
        tx,
        row,
        'ARRIVAL_CHALLENGE_EXPIRED',
        `Handyman arrival challenge expired at server TTL (${HANDYMAN_ARRIVAL_CHALLENGE_TTL_SECONDS}s).`,
      );
    }
    // Deterministic bounded behavior if a live PENDING already
    // exists (existing conflict convention: REJECT, never duplicate).
    const live = await handymanArrivalChallengeRepository
      .lockPendingByScopeActor(tx, executionScopeId, actorUserId);
    if (live) throw arrivalChallengeLiveConflictError();
    let record: HandymanArrivalChallengeRecord;
    try {
      record = await handymanArrivalChallengeRepository
        .insertChallenge(
          tx,
          {
            clientId: scope.clientId,
            executionScopeId: scope.id,
            assignmentId: resolution.assignmentId,
            actorUserId,
            tokenHash,
          },
          HANDYMAN_ARRIVAL_CHALLENGE_TTL_SECONDS,
        );
    } catch (error) {
      // Concurrency backstop: simultaneous creators, exactly one
      // live row can exist (partial unique index).
      if (isUniqueViolation(error)) {
        throw arrivalChallengeLiveConflictError();
      }
      throw error;
    }
    await journal(
      tx,
      record,
      'ARRIVAL_CHALLENGE_CREATED',
      `Handyman arrival challenge issued for execution scope (TTL ${HANDYMAN_ARRIVAL_CHALLENGE_TTL_SECONDS}s).`,
    );
    return { challenge: toPublic(record), token };
  });
}

function safeHashEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * INTERNAL consume primitive (PART 02+ consumes it; NO HTTP yet).
 * Fail-closed on every negative path with ONE generic
 * `HANDYMAN_ARRIVAL_CHALLENGE_INVALID` outcome (non-enumerating);
 * unknown/binding-mismatched challenge ids share the bounded 404
 * shape. Server-server comparison: DB-locked row → server-clock
 * expiry projection → constant-time hash compare → atomic
 * PENDING -> CONSUMED. Replay of CONSUMED/EXPIRED can never succeed.
 */
export async function consumeHandymanArrivalChallenge(
  input: ConsumeHandymanArrivalChallengeInput,
  actorUserId: string,
): Promise<PublicHandymanArrivalChallenge> {
  const challengeId = ensureUuid(input.challengeId, 'challengeId');
  ensureUuid(actorUserId, 'actorUserId');
  const token = typeof input.token === 'string' ? input.token : '';
  if (token.length === 0) throw arrivalChallengeInvalidError();

  // DB-clock expiry FIRST, in its own committed statement: an
  // overdue PENDING expires and STAYS expired even though the
  // consumption itself must fail closed (mandate: PENDING -> EXPIRED
  // and consumption fails — the projection never rolls back with the
  // deliberate failure).
  const projected = await handymanArrivalChallengeRepository
    .expireIfPendingOverdue(getPool(), challengeId);
  if (projected) {
    await journal(
      getPool(),
      projected,
      'ARRIVAL_CHALLENGE_EXPIRED',
      `Handyman arrival challenge expired at server TTL (${HANDYMAN_ARRIVAL_CHALLENGE_TTL_SECONDS}s).`,
    );
  }

  return withTransaction(async (tx) => {
    const row = await handymanArrivalChallengeRepository
      .lockChallengeById(tx, challengeId);
    // Scope/actor binding is part of the challenge's own authority;
    // any mismatch shares the unknown-challenge shape.
    if (!row || row.actorUserId !== actorUserId) {
      throw arrivalChallengeNotFoundError();
    }
    // Replay of CONSUMED — or the just-projected EXPIRED — is the
    // SAME generic fail-closed outcome (non-enumerating).
    if (row.status !== 'PENDING') throw arrivalChallengeInvalidError();
    if (!safeHashEqual(hashSessionToken(token), row.tokenHash)) {
      throw arrivalChallengeInvalidError();
    }
    const consumed = await handymanArrivalChallengeRepository
      .consumeIfPending(tx, challengeId);
    if (!consumed) throw arrivalChallengeInvalidError();
    await journal(
      tx,
      consumed,
      'ARRIVAL_CHALLENGE_CONSUMED',
      'Handyman arrival challenge consumed once (token verified; arrival NOT yet verified).',
    );
    return toPublic(consumed);
  });
}

export const handymanArrivalChallengeService = {
  createHandymanArrivalChallenge,
  consumeHandymanArrivalChallenge,
};

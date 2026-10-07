import { recordOperationalEvent } from '../operational-events';
import { pushDeliveryRecordRepository } from '../notification-push-deliveries';
import type { PushDeliveryRecord } from '../notification-push-deliveries';
import { findPushTokenById, invalidatePushToken } from './push-token.service';
import type { PushTokenRecord } from './push-token.types';

/**
 * CR-BE-PUSH-01 PART 04A — invalid-token lifecycle (governance §8).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The single place where RECORDED per-device attempt evidence is turned into a
 * token-lifecycle decision. PART 03C writes one immutable
 * `notification_push_deliveries` row per device attempt; this module reads
 * those rows back and retires exactly the registrations the provider already
 * proved are dead.
 *
 * EVIDENCE IS THE ONLY AUTHORITY
 * ------------------------------
 * Reconciliation performs a DATABASE READ and nothing else. It never calls the
 * provider, never imports the delivery adapter or its port, and never re-sends
 * anything to "check" a token. If it is not written down in the evidence
 * table, it did not happen. This keeps the decision replayable, auditable and
 * free of provider cost, and it is why the function takes a `deliveryId`
 * rather than an in-memory fan-out result.
 *
 * GOVERNED RULES (§8) — each one is enforced below and covered by a test
 * ---------------------------------------------------------------------
 *   1. ONLY `error_code = 'INVALID_TOKEN'` invalidates. Retryable failures
 *      (RATE_LIMITED, PROVIDER_UNAVAILABLE, NETWORK_ERROR, UNKNOWN_ERROR) and
 *      permanent NON-token failures (PAYLOAD_INVALID, INVALID_REQUEST,
 *      AUTHENTICATION_FAILED — a configuration fault, not a dead handset)
 *      leave every registration exactly as it was.
 *   2. ONLY the exact `push_token_id` named by the evidence row is touched.
 *      A sibling device of the same user is never collateral damage.
 *   3. ACTIVE → INVALID only. The transition is delegated to the PART 01
 *      authority, whose `WHERE status = 'ACTIVE'` clause makes an already
 *      INACTIVE/INVALID row a no-op rather than a re-retirement.
 *   4. The row is RETAINED with its provenance. No DELETE, no column blanking:
 *      `invalidated_at` and a bounded `invalidation_reason` are added, and the
 *      token value stays for forensic linkage to the attempt rows.
 *   5. Re-registration still wins. If the device re-registered AFTER the
 *      failure was recorded, stale evidence must not kill the fresh
 *      registration — see the staleness guard below.
 *
 * IDEMPOTENCY
 * -----------
 * Re-running reconciliation for the same delivery is safe and cheap: the
 * second pass sees the row is no longer ACTIVE and reports it as already
 * invalidated instead of writing again or emitting a duplicate event.
 */

/** Mirrors the `mobile_push_tokens` CHECK added by migration 0334. */
const MAX_INVALIDATION_REASON_LENGTH = 200;

/** Operational-event vocabulary for §8 item 5. */
export const PUSH_TOKEN_INVALIDATED_EVENT = 'NOTIFICATION_PUSH_TOKEN_INVALIDATED';

/** Entity the §8 event is filed against. */
export const PUSH_TOKEN_ENTITY_TYPE = 'MOBILE_PUSH_TOKEN';

/**
 * The one provider verdict that proves a registration is permanently dead.
 * Everything else is explicitly NOT grounds for invalidation.
 */
const INVALIDATING_ERROR_CODE = 'INVALID_TOKEN';

/** Why a candidate row was left alone — recorded so the outcome is explainable. */
export type PushTokenInvalidationSkipReason =
  /** Evidence was a retryable or non-token permanent failure. */
  | 'NOT_INVALID_TOKEN_EVIDENCE'
  /** The registration row named by the evidence no longer exists. */
  | 'TOKEN_NOT_FOUND'
  /** The row was already INACTIVE or INVALID — nothing to transition. */
  | 'TOKEN_NOT_ACTIVE'
  /** The device re-registered after this failure: the evidence is stale. */
  | 'REREGISTERED_AFTER_EVIDENCE'
  /** Evidence and registration disagree on the owner — refuse to guess. */
  | 'OWNER_MISMATCH';

export type PushTokenInvalidationSkip = {
  pushTokenId: string;
  reason: PushTokenInvalidationSkipReason;
};

export type PushTokenInvalidated = {
  pushTokenId: string;
  deviceId: string;
  reason: string;
};

export type PushTokenInvalidationOutcome = {
  /** Registrations transitioned ACTIVE → INVALID by this run. */
  invalidated: PushTokenInvalidated[];
  /** Candidates deliberately left untouched, with the governing reason. */
  skipped: PushTokenInvalidationSkip[];
  /** Distinct evidence rows that named `INVALID_TOKEN`. */
  invalidTokenEvidenceCount: number;
};

/**
 * Builds the stored `invalidation_reason`.
 *
 * The reason is an OPERATIONAL BREADCRUMB, not a message channel: it carries
 * the normalized provider code and the provider name, and is hard-bounded to
 * the column's CHECK width. The token value, the payload and any credential
 * are structurally absent — only the code and provider are interpolated, both
 * of which are adapter-normalized vocabulary.
 */
function buildInvalidationReason(evidence: PushDeliveryRecord): string {
  const provider = (evidence.provider || 'unknown').trim();
  return `${INVALIDATING_ERROR_CODE} reported by provider ${provider}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_INVALIDATION_REASON_LENGTH);
}

/**
 * Decides whether recorded evidence may retire this registration.
 *
 * The staleness guard is the subtle one. A device that re-registers ROTATES
 * its existing row in place (same id, refreshed `last_seen_at`, invalidation
 * fields cleared). So evidence recorded BEFORE that rotation describes a token
 * value the row no longer holds. Acting on it would invalidate a live, healthy
 * handset — the exact regression PART 01's re-registration contract forbids.
 * Comparing the evidence timestamp against `last_seen_at` keeps the newer
 * truth authoritative without re-contacting the provider.
 */
function classifyCandidate(
  evidence: PushDeliveryRecord,
  token: PushTokenRecord | null,
): PushTokenInvalidationSkipReason | null {
  if (!token) {
    return 'TOKEN_NOT_FOUND';
  }
  if (token.userId !== evidence.recipientUserId) {
    return 'OWNER_MISMATCH';
  }
  if (token.status !== 'ACTIVE') {
    return 'TOKEN_NOT_ACTIVE';
  }
  if (token.lastSeenAt.getTime() > evidence.createdAt.getTime()) {
    return 'REREGISTERED_AFTER_EVIDENCE';
  }
  return null;
}

/**
 * Reconciles one ledger delivery's recorded push evidence against the token
 * registry, retiring only the devices the provider proved are dead.
 *
 * Safe to call for any delivery on any channel: a delivery with no push
 * evidence simply reconciles to an empty outcome.
 */
export async function reconcileInvalidTokenEvidence(
  deliveryId: string,
): Promise<PushTokenInvalidationOutcome> {
  const evidenceRows = await pushDeliveryRecordRepository.listByDeliveryId(deliveryId);

  // Only failures that name the token itself are candidates. This filter is
  // the whole of rule 1: every other error code never reaches a write.
  const candidates = evidenceRows.filter(
    (row) => row.status === 'FAILED' && row.errorCode === INVALIDATING_ERROR_CODE,
  );

  const invalidated: PushTokenInvalidated[] = [];
  const skipped: PushTokenInvalidationSkip[] = [];

  // One decision per DISTINCT registration: several failed attempts against
  // the same device must not produce several writes or several events.
  const seen = new Set<string>();

  for (const evidence of candidates) {
    if (seen.has(evidence.pushTokenId)) {
      continue;
    }
    seen.add(evidence.pushTokenId);

    // Read the CURRENT registration state — the evidence says what happened,
    // the registry says what is true now, and both must agree before a write.
    const token = await findPushTokenById(evidence.pushTokenId);
    const skipReason = classifyCandidate(evidence, token);
    if (skipReason) {
      skipped.push({ pushTokenId: evidence.pushTokenId, reason: skipReason });
      continue;
    }

    const reason = buildInvalidationReason(evidence);

    // PART 01 owns the transition. Its guarded UPDATE is what makes this
    // ACTIVE-only and exact-id-only; a concurrent unregister or rotation
    // between the read above and this write simply returns null.
    const updated = await invalidatePushToken(evidence.pushTokenId, reason);
    if (!updated) {
      skipped.push({ pushTokenId: evidence.pushTokenId, reason: 'TOKEN_NOT_ACTIVE' });
      continue;
    }

    invalidated.push({
      pushTokenId: updated.id,
      deviceId: updated.deviceId,
      reason,
    });

    // §8 item 5 — one operational event per invalidation, carrying the DEVICE
    // identity and the reason. The token value is never included.
    await recordOperationalEvent({
      clientId: evidence.clientId,
      eventType: PUSH_TOKEN_INVALIDATED_EVENT,
      entityType: PUSH_TOKEN_ENTITY_TYPE,
      entityId: updated.id,
      buildingId: evidence.buildingId,
      summary: `Push registration for device ${updated.deviceId} invalidated: ${reason}`,
      metadata: {
        pushTokenId: updated.id,
        deviceId: updated.deviceId,
        platform: updated.platform,
        provider: evidence.provider,
        errorCode: INVALIDATING_ERROR_CODE,
        reason,
        deliveryId,
      },
    });
  }

  return {
    invalidated,
    skipped,
    invalidTokenEvidenceCount: seen.size,
  };
}

import { recordOperationalEvent } from '../operational-events';
import { browserPushDeliveryRecordRepository } from '../notification-browser-push-deliveries';
import type { BrowserPushDeliveryRecord } from '../notification-browser-push-deliveries';
import {
  findBrowserPushSubscriptionById,
  invalidateBrowserPushSubscription,
} from './browser-push-subscription.service';
import type { BrowserPushSubscriptionRecord } from './browser-push-subscription.types';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — invalid-subscription lifecycle
 * (the browser counterpart of the native §8 reconciliation).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The single place where RECORDED per-subscription attempt evidence is turned
 * into a subscription-lifecycle decision. The fan-out writes one immutable
 * `notification_browser_push_deliveries` row per subscription attempt; this
 * module reads those rows back and retires exactly the subscriptions the
 * push service already proved are gone.
 *
 * EVIDENCE IS THE ONLY AUTHORITY
 * ------------------------------
 * Reconciliation performs a DATABASE READ and nothing else. It never calls
 * the push service, never imports the transport adapter or its port, and
 * never re-sends anything to "check" a subscription. If it is not written
 * down in the evidence table, it did not happen.
 *
 * GOVERNED RULES (mirroring the native §8 rules) — each one is covered by a
 * test:
 *   1. ONLY `error_code = 'INVALID_TOKEN'` invalidates. A retryable failure
 *      and a configuration failure leave every subscription untouched.
 *   2. ONLY the exact subscription named by the evidence row is touched.
 *   3. ACTIVE → INVALID only (the guarded UPDATE makes a re-retirement a
 *      no-op).
 *   4. The row is RETAINED with its provenance. No DELETE, no blanking.
 *   5. Re-registration still wins: evidence recorded BEFORE the browser
 *      re-registered describes a subscription that no longer exists on that
 *      row, so it must not kill the fresh registration.
 */

/** Mirrors the `browser_push_subscriptions` CHECK added by migration 0473. */
const MAX_INVALIDATION_REASON_LENGTH = 200;

/** Operational-event vocabulary for the browser invalidation. */
export const BROWSER_PUSH_SUBSCRIPTION_INVALIDATED_EVENT =
  'NOTIFICATION_BROWSER_PUSH_SUBSCRIPTION_INVALIDATED';

/** Entity the browser invalidation event is filed against. */
export const BROWSER_PUSH_SUBSCRIPTION_ENTITY_TYPE = 'BROWSER_PUSH_SUBSCRIPTION';

/**
 * The one push-service verdict that proves a subscription is permanently
 * dead. Everything else is explicitly NOT grounds for invalidation.
 */
const INVALIDATING_ERROR_CODE = 'INVALID_TOKEN';

/** Why a candidate row was left alone — recorded so the outcome is explainable. */
export type BrowserPushSubscriptionInvalidationSkipReason =
  | 'NOT_INVALID_TOKEN_EVIDENCE'
  | 'SUBSCRIPTION_NOT_FOUND'
  | 'SUBSCRIPTION_NOT_ACTIVE'
  | 'REREGISTERED_AFTER_EVIDENCE'
  | 'OWNER_MISMATCH';

export type BrowserPushSubscriptionInvalidationSkip = {
  browserSubscriptionId: string;
  reason: BrowserPushSubscriptionInvalidationSkipReason;
};

export type BrowserPushSubscriptionInvalidated = {
  browserSubscriptionId: string;
  deviceId: string;
  reason: string;
};

export type BrowserPushSubscriptionInvalidationOutcome = {
  /** Subscriptions transitioned ACTIVE → INVALID by this run. */
  invalidated: BrowserPushSubscriptionInvalidated[];
  /** Candidates deliberately left untouched, with the governing reason. */
  skipped: BrowserPushSubscriptionInvalidationSkip[];
  /** Distinct evidence rows that named `INVALID_TOKEN`. */
  invalidTokenEvidenceCount: number;
};

/**
 * Builds the stored `invalidation_reason`: the normalized provider code and
 * the provider name. The endpoint, the key material and the payload are
 * structurally absent.
 */
function buildInvalidationReason(evidence: BrowserPushDeliveryRecord): string {
  const provider = (evidence.provider || 'unknown').trim();
  return `${INVALIDATING_ERROR_CODE} reported by provider ${provider}`
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_INVALIDATION_REASON_LENGTH);
}

/**
 * Decides whether recorded evidence may retire this subscription.
 *
 * The staleness guard is the subtle one: a browser that re-registers ROTATES
 * its existing row in place (same id, refreshed `last_seen_at`, invalidation
 * fields cleared). Evidence recorded BEFORE that rotation describes a
 * subscription the row no longer holds, so acting on it would kill a live,
 * healthy browser — the exact regression the re-registration contract
 * forbids.
 */
function classifyCandidate(
  evidence: BrowserPushDeliveryRecord,
  subscription: BrowserPushSubscriptionRecord | null,
): BrowserPushSubscriptionInvalidationSkipReason | null {
  if (!subscription) {
    return 'SUBSCRIPTION_NOT_FOUND';
  }
  if (subscription.userId !== evidence.recipientUserId) {
    return 'OWNER_MISMATCH';
  }
  if (subscription.status !== 'ACTIVE') {
    return 'SUBSCRIPTION_NOT_ACTIVE';
  }
  if (subscription.lastSeenAt.getTime() > evidence.createdAt.getTime()) {
    return 'REREGISTERED_AFTER_EVIDENCE';
  }
  return null;
}

/**
 * Reconciles one ledger delivery's recorded browser evidence against the
 * subscription registry, retiring only the subscriptions the push service
 * proved are gone.
 *
 * Safe to call for any delivery on any channel: a delivery with no browser
 * evidence simply reconciles to an empty outcome.
 */
export async function reconcileInvalidBrowserSubscriptionEvidence(
  deliveryId: string,
): Promise<BrowserPushSubscriptionInvalidationOutcome> {
  const evidenceRows =
    await browserPushDeliveryRecordRepository.listByDeliveryId(deliveryId);

  // Only failures that name the subscription itself are candidates.
  const candidates = evidenceRows.filter(
    (row) => row.status === 'FAILED' && row.errorCode === INVALIDATING_ERROR_CODE,
  );

  const invalidated: BrowserPushSubscriptionInvalidated[] = [];
  const skipped: BrowserPushSubscriptionInvalidationSkip[] = [];

  const seen = new Set<string>();

  for (const evidence of candidates) {
    if (seen.has(evidence.browserSubscriptionId)) {
      continue;
    }
    seen.add(evidence.browserSubscriptionId);

    const subscription = await findSubscriptionForReconciliation(
      evidence.browserSubscriptionId,
    );
    const skipReason = classifyCandidate(evidence, subscription);
    if (skipReason) {
      skipped.push({
        browserSubscriptionId: evidence.browserSubscriptionId,
        reason: skipReason,
      });
      continue;
    }

    const reason = buildInvalidationReason(evidence);
    const updated = await invalidateBrowserPushSubscription(
      evidence.browserSubscriptionId,
      reason,
    );
    if (!updated) {
      skipped.push({
        browserSubscriptionId: evidence.browserSubscriptionId,
        reason: 'SUBSCRIPTION_NOT_ACTIVE',
      });
      continue;
    }

    invalidated.push({
      browserSubscriptionId: updated.id,
      deviceId: updated.deviceId,
      reason,
    });

    await recordOperationalEvent({
      clientId: evidence.clientId,
      eventType: BROWSER_PUSH_SUBSCRIPTION_INVALIDATED_EVENT,
      entityType: BROWSER_PUSH_SUBSCRIPTION_ENTITY_TYPE,
      entityId: updated.id,
      buildingId: evidence.buildingId,
      summary: `Browser push subscription for device ${updated.deviceId} invalidated: ${reason}`,
      metadata: {
        browserSubscriptionId: updated.id,
        deviceId: updated.deviceId,
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

/** Reads the CURRENT state of one subscription, whatever its status. */
async function findSubscriptionForReconciliation(
  subscriptionId: string,
): Promise<BrowserPushSubscriptionRecord | null> {
  return findBrowserPushSubscriptionById(subscriptionId);
}

import { logger } from '../../shared/logger';
import {
  recordBrowserPushSubscriptionFailure,
  recordBrowserPushSubscriptionSuccess,
} from './browser-push-subscription.service';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 02 — per-subscription delivery
 * telemetry (the browser counterpart of the native §6-7 telemetry).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The single place where the outcome of ONE fan-out attempt is folded into
 * the health counters of `browser_push_subscriptions`: `last_success_at`,
 * `last_failure_at` and `consecutive_failure_count`.
 *
 * TELEMETRY IS NOT AUTHORIZATION STATE
 * -------------------------------------
 * These counters are observability only. Nothing here changes a
 * subscription's `status`, and no code may gate a send on the streak: a
 * subscription is eligible for fan-out because it is ACTIVE, never because
 * its failure count is low. Only push-service-proven `INVALID_TOKEN`
 * evidence retires a subscription, and that decision belongs exclusively to
 * the reconciliation seam.
 *
 * INVALID_TOKEN IS DELIBERATELY EXCLUDED
 * ---------------------------------------
 * The invalidation UPDATE already stamps `last_failure_at` and increments the
 * streak in one write, so counting an INVALID_TOKEN attempt here as well
 * would double-count it. Those attempts are left entirely to the
 * reconciliation seam; the evidence row is retained either way.
 *
 * Never throws. Telemetry is strictly subordinate to delivery.
 */

/** The per-subscription attempt facts this module needs. */
export type BrowserPushSubscriptionTelemetryAttempt = {
  browserSubscriptionId: string;
  outcome: string;
  provider: string | null;
};

/** Why an attempt did not move any counter — surfaced so the outcome is explainable. */
export type BrowserPushSubscriptionTelemetrySkipReason =
  | 'INVALID_TOKEN_OWNED_BY_LIFECYCLE'
  | 'SUBSCRIPTION_NOT_FOUND';

export type BrowserPushSubscriptionTelemetryOutcome = {
  browserSubscriptionId: string;
  applied: 'SUCCESS' | 'FAILURE' | null;
  skipReason: BrowserPushSubscriptionTelemetrySkipReason | null;
};

/** The one push-service verdict whose counters the lifecycle owns. */
const LIFECYCLE_OWNED_OUTCOME = 'INVALID_TOKEN';

/** The push-service verdict that means the service accepted the message. */
const ACCEPTED_OUTCOME = 'ACCEPTED';

/**
 * Folds one fan-out pass into the browser subscription health counters.
 *
 * Accepted → refresh `last_success_at` and RESET the streak to zero.
 * Retryable or permanent failure → stamp `last_failure_at` and INCREMENT the
 * streak. Neither changes `status`.
 */
export async function recordBrowserPushAttemptTelemetry(
  attempts: readonly BrowserPushSubscriptionTelemetryAttempt[],
): Promise<BrowserPushSubscriptionTelemetryOutcome[]> {
  const outcomes: BrowserPushSubscriptionTelemetryOutcome[] = [];

  for (const attempt of attempts) {
    if (attempt.outcome === LIFECYCLE_OWNED_OUTCOME) {
      outcomes.push({
        browserSubscriptionId: attempt.browserSubscriptionId,
        applied: null,
        skipReason: 'INVALID_TOKEN_OWNED_BY_LIFECYCLE',
      });
      continue;
    }

    const accepted = attempt.outcome === ACCEPTED_OUTCOME;

    try {
      const updated = accepted
        ? await recordBrowserPushSubscriptionSuccess(
            attempt.browserSubscriptionId,
            attempt.provider,
          )
        : await recordBrowserPushSubscriptionFailure(
            attempt.browserSubscriptionId,
            attempt.provider,
          );

      if (!updated) {
        outcomes.push({
          browserSubscriptionId: attempt.browserSubscriptionId,
          applied: null,
          skipReason: 'SUBSCRIPTION_NOT_FOUND',
        });
        continue;
      }

      outcomes.push({
        browserSubscriptionId: attempt.browserSubscriptionId,
        applied: accepted ? 'SUCCESS' : 'FAILURE',
        skipReason: null,
      });
    } catch (error) {
      // Deliberately swallowed: telemetry must never fail a send that already
      // happened.
      logger.error(
        `Browser push subscription telemetry update failed for ${attempt.browserSubscriptionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      outcomes.push({
        browserSubscriptionId: attempt.browserSubscriptionId,
        applied: null,
        skipReason: 'SUBSCRIPTION_NOT_FOUND',
      });
    }
  }

  return outcomes;
}

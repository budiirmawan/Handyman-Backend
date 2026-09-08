import { logger } from '../../shared/logger';
import { recordPushTokenFailure, recordPushTokenSuccess } from './push-token.service';

/**
 * CR-BE-PUSH-01 PART 04B — per-device delivery telemetry (governance §6-7).
 *
 * WHAT THIS MODULE IS
 * -------------------
 * The single place where the outcome of ONE fan-out attempt is folded into the
 * PART 01 health counters on `mobile_push_tokens`:
 * `last_success_at`, `last_failure_at` and `consecutive_failure_count`.
 *
 * PART 01 shipped the recorders (`recordPushTokenSuccess` /
 * `recordPushTokenFailure`) but nothing ever called them, so every
 * registration's streak sat frozen at its registration-time default no matter
 * how many times the provider accepted or rejected it. This module closes that
 * gap and nothing else.
 *
 * TELEMETRY IS NOT AUTHORIZATION STATE (§7)
 * -----------------------------------------
 * These counters are observability only. Nothing here changes a token's
 * `status`, and no code may gate a send on the streak: a device is eligible
 * for fan-out because it is ACTIVE, never because its failure count is low. A
 * high streak is a signal for operators, not a silent retirement — only
 * provider-proven `INVALID_TOKEN` evidence retires a device, and that decision
 * belongs exclusively to PART 04A.
 *
 * WHY THE CURRENT ATTEMPT, NOT THE DELIVERY'S HISTORY
 * ---------------------------------------------------
 * PART 04A reconciles by re-reading every evidence row for a `delivery_id`,
 * which is right for a lifecycle decision: it is idempotent, because the
 * second pass finds the token already non-ACTIVE and does nothing.
 *
 * Counter arithmetic has no such self-limiting property. A retry writes ANOTHER
 * evidence row under the SAME logical delivery (one delivery → N device
 * attempts over time), so reconciling by `delivery_id` would re-count every
 * earlier attempt on every retry and inflate the streak superlinearly. This
 * function is therefore handed the attempts from the CURRENT fan-out pass only,
 * so each provider call moves each counter exactly once.
 *
 * INVALID_TOKEN IS DELIBERATELY EXCLUDED (§8 / PART 04A)
 * ------------------------------------------------------
 * `invalidatePushToken` already stamps `last_failure_at` and increments the
 * streak in the same UPDATE that retires the row. Counting an INVALID_TOKEN
 * attempt here as well would double-count it, so those attempts are skipped and
 * left entirely to PART 04A. The evidence row is still retained either way.
 *
 * MULTI-DEVICE INDEPENDENCE (§6)
 * ------------------------------
 * Every write targets the exact `push_token_id` the attempt was made against.
 * One device accepting never resets a sibling's streak, and one device failing
 * never marks a sibling unhealthy.
 */

/** The per-device attempt facts this module needs — a structural subset of `PushFanoutAttempt`. */
export type PushTokenTelemetryAttempt = {
  pushTokenId: string;
  outcome: string;
  provider: string | null;
};

/** Why an attempt did not move any counter — surfaced so the outcome is explainable. */
export type PushTokenTelemetrySkipReason =
  /** PART 04A owns this attempt's bookkeeping (it invalidates and counts in one write). */
  | 'INVALID_TOKEN_OWNED_BY_LIFECYCLE'
  /** The registration disappeared between the send and this update. */
  | 'TOKEN_NOT_FOUND';

export type PushTokenTelemetryOutcome = {
  pushTokenId: string;
  applied: 'SUCCESS' | 'FAILURE' | null;
  skipReason: PushTokenTelemetrySkipReason | null;
};

/**
 * The one provider verdict whose counters PART 04A writes, so this module must
 * not write them again.
 */
const LIFECYCLE_OWNED_OUTCOME = 'INVALID_TOKEN';

/** The provider verdict that means the device received the message. */
const ACCEPTED_OUTCOME = 'ACCEPTED';

/**
 * Folds one fan-out pass into the PART 01 health counters.
 *
 * Accepted → refresh `last_success_at` and RESET the streak to zero, because a
 * delivered message proves the registration is alive regardless of how many
 * attempts preceded it.
 *
 * Retryable or permanent failure → stamp `last_failure_at` and INCREMENT the
 * streak. Neither changes `status`: a permanent, non-token failure (a bad
 * payload, a configuration fault) is a defect on our side and must never be
 * allowed to retire a perfectly good handset.
 *
 * Never throws. Telemetry is strictly subordinate to delivery: a counter that
 * fails to update must not fail a send that already happened, so failures are
 * logged and swallowed.
 */
export async function recordPushAttemptTelemetry(
  attempts: readonly PushTokenTelemetryAttempt[],
): Promise<PushTokenTelemetryOutcome[]> {
  const outcomes: PushTokenTelemetryOutcome[] = [];

  for (const attempt of attempts) {
    if (attempt.outcome === LIFECYCLE_OWNED_OUTCOME) {
      outcomes.push({
        pushTokenId: attempt.pushTokenId,
        applied: null,
        skipReason: 'INVALID_TOKEN_OWNED_BY_LIFECYCLE',
      });
      continue;
    }

    const accepted = attempt.outcome === ACCEPTED_OUTCOME;

    try {
      const updated = accepted
        ? await recordPushTokenSuccess(attempt.pushTokenId, attempt.provider)
        : await recordPushTokenFailure(attempt.pushTokenId, attempt.provider);

      if (!updated) {
        outcomes.push({
          pushTokenId: attempt.pushTokenId,
          applied: null,
          skipReason: 'TOKEN_NOT_FOUND',
        });
        continue;
      }

      outcomes.push({
        pushTokenId: attempt.pushTokenId,
        applied: accepted ? 'SUCCESS' : 'FAILURE',
        skipReason: null,
      });
    } catch (error) {
      // Deliberately swallowed: see the "never throws" contract above.
      logger.error(
        `Push token telemetry update failed for ${attempt.pushTokenId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      outcomes.push({
        pushTokenId: attempt.pushTokenId,
        applied: null,
        skipReason: 'TOKEN_NOT_FOUND',
      });
    }
  }

  return outcomes;
}

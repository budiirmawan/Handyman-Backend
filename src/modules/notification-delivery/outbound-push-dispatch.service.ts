import {
  classifyPushResult,
  resolvePushDeliveryPort,
  sanitizeProviderError,
  type PushDeliveryOutcome,
  type PushDeliveryPort,
  type PushSendResult,
} from '../push-delivery';
import { pushDeliveryRecordRepository } from '../notification-push-deliveries';
import type { OutboundDeliveryRecord } from '../notification-outbound-deliveries';
import type { BuildPushPointerPayloadOptions } from './outbound-push-payload';
import {
  resolvePushFanoutPlan,
  type PushFanoutEmptyReason,
  type PushFanoutTarget,
} from './outbound-push-fanout.service';

/**
 * CR-BE-PUSH-01 PART 03C — provider invocation & per-device attempt evidence.
 *
 * GOVERNANCE: docs/CR-BE-PUSH-01_START_GOVERNANCE.md §10.2 (fan-out shape and
 * the ledger outcome rule), §8 (invalid-token handling), §13.2 (failure
 * taxonomy), §12.7 (`notification_push_deliveries`).
 *
 * This is the ONLY seam that invokes the push provider port. It sits between
 * the fan-out resolver (PART 03B, which decides WHO and WHAT) and the
 * outbound execution service (PART 04's retry engine, which owns the ledger
 * transition). Its job is narrow: call the adapter once per active device,
 * record one immutable evidence row per call, and roll the N device results
 * up into ONE ledger-level outcome.
 *
 * THE ADAPTER PORT IS THE ONLY PROVIDER PATH
 * ------------------------------------------
 * Nothing here knows a provider exists beyond the `PushDeliveryPort`
 * interface: no vendor SDK, no HTTP client, no endpoint URL, no credential
 * read, no provider-specific error string. `resolvePushDeliveryPort()` is the
 * single
 * fail-closed selection point (it refuses real providers under NODE_ENV=test),
 * and the port is resolved ONCE per ledger row so every device in one fan-out
 * is sent through the same adapter instance.
 *
 * ONE LOGICAL OUTBOUND ROW PER RECIPIENT (§10.2)
 * ----------------------------------------------
 * Fan-out never creates a second ledger row. The recipient's ledger row stays
 * the single unit of idempotency, retry and history; the N device results
 * live in `notification_push_deliveries` underneath it. That is why this
 * function returns ONE rolled-up outcome rather than N.
 *
 * INVALID_TOKEN IS EVIDENCE ONLY (PART 03C scope)
 * -----------------------------------------------
 * A provider proving a token is dead is recorded — `status = FAILED`,
 * `error_code = INVALID_TOKEN` — and nothing else. This module deliberately
 * does NOT call `invalidatePushToken()` and does not touch
 * `mobile_push_tokens` in any way. The §8 device-state transition (INVALID +
 * `invalidated_at` + reason + the operational event) is a later PART's duty;
 * performing it here would couple the send path to device lifecycle mutation
 * before that transition has been validated on its own.
 *
 * RETRY IS NOT DECIDED HERE
 * -------------------------
 * No backoff maths, no `next_retry_at`, no attempt counter, no timer, no
 * queue and no worker. This module reports a classification; the existing
 * PART 04 retry engine converts it into a schedule using the algorithm it
 * already owns, unchanged.
 */

/** Per-device evidence produced by one adapter call. */
export type PushFanoutAttempt = {
  pushTokenId: string;
  deviceId: string;
  platform: string;
  outcome: PushDeliveryOutcome;
  provider: string;
  providerMessageId: string | null;
  errorCode: string | null;
  error: string | null;
  sentAt: Date | null;
  /** Id of the `notification_push_deliveries` row written for this attempt. */
  attemptRecordId: string | null;
};

/** The rolled-up result of fanning ONE ledger row out to N devices. */
export type PushFanoutExecution = {
  deliveryId: string;
  recipientUserId: string;
  provider: string;
  /**
   * The single ledger-level classification, in the SAME vocabulary the
   * EMAIL/WhatsApp path already uses, so the retry engine needs no push
   * branch.
   */
  outcome: 'ACCEPTED' | 'REJECTED_RETRYABLE' | 'REJECTED_PERMANENT';
  /** First provider message id from an accepted device, when any. */
  providerMessageId: string | null;
  /** Sanitized rollup error, null when at least one device accepted. */
  error: string | null;
  /** Earliest acceptance time, or null when nothing was accepted. */
  sentAt: Date | null;
  attempts: PushFanoutAttempt[];
  accepted: number;
  failed: number;
  invalidTokens: number;
  /** Set only when there was nothing to send to (§13.2 "No devices"). */
  emptyReason: PushFanoutEmptyReason | null;
};

/** Human-readable, non-sensitive reason text for the zero-device outcomes. */
const EMPTY_REASON_MESSAGES: Record<PushFanoutEmptyReason, string> = {
  NO_REGISTRATIONS:
    'Push not delivered: the recipient has no registered devices.',
  NO_ACTIVE_REGISTRATIONS:
    'Push not delivered: the recipient has no active device registrations.',
};

export type ExecutePushFanoutOptions = BuildPushPointerPayloadOptions & {
  /** Test seam: inject a port implementation instead of resolving one. */
  adapter?: PushDeliveryPort;
};

/**
 * Sanitizes then truncates provider error text to the `0336` column bound.
 *
 * CR-BE-PUSH-01 PART 04C §16: the previous version only bounded length, on the
 * assumption that "the adapter already sanitizes". That holds for the governed
 * adapter (which redacts during its own classification) but NOT for a RETURNED
 * failure from any other port implementation — only the THROWN path in
 * `sendToDevice` was scrubbed. This is the last stop before the text becomes
 * immutable attempt evidence, so it redacts here too. `sanitizeProviderError`
 * is idempotent, so sanitizing already-clean adapter text is a no-op and no
 * redaction logic is duplicated.
 */
function boundError(message: string): string {
  const collapsed = sanitizeProviderError(message).replace(/\s+/g, ' ').trim();
  return collapsed.length <= 500 ? collapsed : `${collapsed.slice(0, 499)}…`;
}

/**
 * Rolls N per-device outcomes into ONE ledger outcome (§10.2).
 *
 *   - at least one device accepted            → ACCEPTED (the notification
 *     reached the person; a dead second handset must not fail the delivery),
 *   - nothing accepted but something transient → REJECTED_RETRYABLE,
 *   - otherwise (all permanent / all invalid)  → REJECTED_PERMANENT.
 *
 * INVALID_TOKEN is permanent FOR THAT DEVICE and never retryable, so a
 * recipient whose every device is dead fails permanently instead of burning
 * the retry budget re-sending to tokens the provider already rejected.
 */
function rollUpOutcome(
  attempts: PushFanoutAttempt[],
): 'ACCEPTED' | 'REJECTED_RETRYABLE' | 'REJECTED_PERMANENT' {
  if (attempts.some((attempt) => attempt.outcome === 'ACCEPTED')) {
    return 'ACCEPTED';
  }
  if (attempts.some((attempt) => attempt.outcome === 'REJECTED_RETRYABLE')) {
    return 'REJECTED_RETRYABLE';
  }
  return 'REJECTED_PERMANENT';
}

/**
 * Sends one device's copy through the port and normalizes the result.
 *
 * An adapter THROW is contained here and classified REJECTED_RETRYABLE rather
 * than propagated: one handset's transport failure must not abort the fan-out
 * and rob the recipient's other devices of their notification. The throw is
 * still recorded as evidence, so it is never a silent loss.
 */
async function sendToDevice(
  adapter: PushDeliveryPort,
  target: PushFanoutTarget,
  payload: { title: string; body: string | null; data: Record<string, string> },
  deliveryId: string,
): Promise<{ outcome: PushDeliveryOutcome; result: PushSendResult }> {
  try {
    const result = await adapter.send({
      token: target.token,
      platform: target.platform,
      title: payload.title,
      body: payload.body,
      data: payload.data,
      deliveryId,
    });
    return { outcome: classifyPushResult(result), result };
  } catch (error) {
    // A THROWN provider error bypasses the adapter's own classification (and
    // therefore its redaction), so it is the one provider string that can
    // still carry a credential — an auth header, an access token echoed in a
    // request URL, a key in a stack message. Scrub it here before it becomes
    // immutable attempt evidence.
    const message = sanitizeProviderError(
      error instanceof Error ? error.message : String(error),
    );
    return {
      outcome: 'REJECTED_RETRYABLE',
      result: {
        status: 'FAILED',
        provider: adapter.provider,
        error: message,
        errorCode: 'UNKNOWN_ERROR',
        retryable: true,
        sentAt: new Date(),
      },
    };
  }
}

/**
 * Fans ONE PUSH ledger row out to the recipient's ACTIVE devices, invoking
 * the provider port once per device and writing one evidence row per call.
 *
 * Returns `null` when the row is not a fan-out-able PUSH row (wrong channel
 * or an unusable recipient reference) — the caller decides; this module never
 * guesses a recipient.
 *
 * ZERO ACTIVE DEVICES: no adapter call is made, no evidence row is written
 * (there was no attempt to evidence), and the outcome is REJECTED_PERMANENT
 * with an explicit reason. Per §13.2 this must never consume the retry budget:
 * retrying cannot conjure a device.
 */
export async function executePushFanout(
  record: OutboundDeliveryRecord,
  options: ExecutePushFanoutOptions = {},
): Promise<PushFanoutExecution | null> {
  const { adapter: injected, ...payloadOptions } = options;

  const plan = await resolvePushFanoutPlan(record, payloadOptions);
  if (!plan) {
    return null;
  }

  // Resolved ONCE per ledger row: every device in this fan-out goes through
  // the same port instance, and the provider recorded on the evidence rows is
  // the one that actually ran.
  const adapter = injected ?? resolvePushDeliveryPort();

  if (plan.targets.length === 0) {
    const reason = plan.emptyReason ?? 'NO_ACTIVE_REGISTRATIONS';
    return {
      deliveryId: plan.deliveryId,
      recipientUserId: plan.recipientUserId,
      provider: adapter.provider,
      outcome: 'REJECTED_PERMANENT',
      providerMessageId: null,
      error: EMPTY_REASON_MESSAGES[reason],
      sentAt: null,
      attempts: [],
      accepted: 0,
      failed: 0,
      invalidTokens: 0,
      emptyReason: reason,
    };
  }

  // §9 payload `data` is string→string and identical for every device.
  const data = plan.payload.data as Record<string, string>;

  const attempts: PushFanoutAttempt[] = [];
  for (const target of plan.targets) {
    const { outcome, result } = await sendToDevice(
      adapter,
      target,
      { title: plan.payload.title, body: plan.payload.body, data },
      plan.deliveryId,
    );

    const accepted = outcome === 'ACCEPTED';
    const error = result.error ? boundError(result.error) : null;
    const providerMessageId = result.providerMessageId ?? null;

    // Immutable per-device evidence — written for EVERY call, success or
    // failure, before the ledger is touched. The token VALUE is never stored;
    // the device is identified by push_token_id / device_id.
    const stored = await pushDeliveryRecordRepository.create({
      clientId: record.clientId,
      buildingId: record.buildingId,
      recipientUserId: plan.recipientUserId,
      pushTokenId: target.pushTokenId,
      deviceId: target.deviceId,
      platform: target.platform,
      templateKey: record.templateKey,
      title: plan.payload.title,
      body: plan.payload.body,
      status: accepted ? 'SENT' : 'FAILED',
      provider: result.provider ?? adapter.provider,
      providerReference: providerMessageId,
      errorMessage: accepted ? null : error,
      errorCode: accepted ? null : (result.errorCode ?? null),
      sentAt: accepted ? result.sentAt : null,
      deliveryId: record.id,
    });

    attempts.push({
      pushTokenId: target.pushTokenId,
      deviceId: target.deviceId,
      platform: target.platform,
      outcome,
      provider: result.provider ?? adapter.provider,
      providerMessageId,
      errorCode: accepted ? null : (result.errorCode ?? null),
      error: accepted ? null : error,
      sentAt: accepted ? result.sentAt : null,
      attemptRecordId: stored.id,
    });
  }

  const rolled = rollUpOutcome(attempts);
  const acceptedAttempts = attempts.filter((attempt) => attempt.outcome === 'ACCEPTED');
  const invalidTokens = attempts.filter(
    (attempt) => attempt.outcome === 'INVALID_TOKEN',
  ).length;

  // Ledger-level error text summarises the fan-out without naming a device or
  // echoing a token: the per-device detail lives in the evidence rows.
  const firstFailure = attempts.find((attempt) => attempt.outcome !== 'ACCEPTED');
  const rollupError =
    rolled === 'ACCEPTED'
      ? null
      : boundError(
          `Push failed on ${attempts.length} device(s)` +
            (invalidTokens > 0 ? `, ${invalidTokens} with an invalid token` : '') +
            (firstFailure?.error ? `: ${firstFailure.error}` : '.'),
        );

  const sentAt = acceptedAttempts.reduce<Date | null>((earliest, attempt) => {
    if (!attempt.sentAt) {
      return earliest;
    }
    return !earliest || attempt.sentAt < earliest ? attempt.sentAt : earliest;
  }, null);

  return {
    deliveryId: plan.deliveryId,
    recipientUserId: plan.recipientUserId,
    provider: adapter.provider,
    outcome: rolled,
    providerMessageId: acceptedAttempts[0]?.providerMessageId ?? null,
    error: rollupError,
    sentAt,
    attempts,
    accepted: acceptedAttempts.length,
    failed: attempts.length - acceptedAttempts.length,
    invalidTokens,
    emptyReason: null,
  };
}

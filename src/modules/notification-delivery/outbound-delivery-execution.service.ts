import { withTransaction } from '../../database';
import { logger } from '../../shared/logger';
import {
  classifyProviderResult,
  isRetryableProviderOutcome,
  type DeliveryProviderOutcome,
} from '../../shared/provider-result';
import { emailDeliveryRepository, resolveEmailAdapter, sanitizeEmailError } from '../email-delivery';
import type { EmailAdapter } from '../email-delivery';
import {
  notificationOutboundDeliveryRepository as ledgerRepository,
  type OutboundDeliveryChannel,
  type OutboundDeliveryRecord,
} from '../notification-outbound-deliveries';
import { recordOperationalEvent } from '../operational-events';
import {
  resolveWhatsAppAdapter,
  sanitizeWhatsAppError,
  whatsappDeliveryRepository,
} from '../whatsapp-delivery';
import type { WhatsAppAdapter } from '../whatsapp-delivery';
import { sanitizeProviderError } from '../push-delivery';
import { recordPushAttemptTelemetry } from '../push-tokens/push-token-delivery-telemetry.service';
import { reconcileInvalidTokenEvidence } from '../push-tokens/push-token-invalidation.service';
import { executePushFanout } from './outbound-push-dispatch.service';
import type { ExecutePushFanoutOptions } from './outbound-push-dispatch.service';

/**
 * CR-BE-NOTIFY-PROV-01 PART 04 — outbound delivery execution + retry engine.
 *
 * Drains the PART 02 ledger through the governance §3.1 chain:
 *
 *   due ledger row → guarded claim (PENDING/RETRY_SCHEDULED → SENDING)
 *     → channel adapter send (PART 01 resolvers, noop/capture today)
 *     → immutable attempt-history row (BE-26F/G tables, + delivery_id)
 *     → guarded result transition per the PART 01 taxonomy outcome
 *     → operational event (§10 vocabulary).
 *
 * TAXONOMY HANDLING (§3.3)
 * ------------------------
 *   ACCEPTED           → markSent (terminal SENT),
 *   REJECTED_RETRYABLE → retry window (or EXHAUSTED when the budget ran out),
 *   REJECTED_PERMANENT → markFailedPermanent (terminal),
 *   ERROR_UNKNOWN      → adapter threw / unclassifiable: treated as retryable
 *                        until attempts are exhausted (never a silent loss).
 *
 * RETRY / BACKOFF (§7.2)
 * ----------------------
 * Exponential backoff with jitter from NAMED CONFIG CONSTANTS (never
 * hardcoded inside logic): delay = min(base · 2^(attempt−1), cap) scaled by a
 * jitter factor in [1−r, 1+r]. Retries are durable (next_retry_at on the
 * ledger) and drained by the due-job dispatcher — no in-process timers.
 *
 * IDEMPOTENCY / AT-MOST-ONCE (§7.1)
 * ---------------------------------
 * The guarded claim is the single owner of an attempt: exactly one caller
 * ever proceeds past it, every result seam is status-guarded on SENDING, and
 * a second run over the same window finds nothing claimable. Exactly one
 * attempt-history row is written per adapter call.
 */

// ---------------------------------------------------------------------------
// Retry configuration constants (governance §7.2 proposed defaults)
// ---------------------------------------------------------------------------

/** Base retry delay: 5 minutes. */
export const OUTBOUND_RETRY_BASE_MS = 5 * 60_000;
/** Retry delay ceiling: 6 hours. */
export const OUTBOUND_RETRY_CAP_MS = 6 * 60 * 60_000;
/** Jitter ratio: ±25% around the deterministic delay. */
export const OUTBOUND_RETRY_JITTER_RATIO = 0.25;
/** Default attempt budget for ledger rows (the ledger column default). */
export const OUTBOUND_DEFAULT_MAX_ATTEMPTS = 5;
/** Bounded due-retrieval batch for one execution pass. */
export const OUTBOUND_DUE_RETRIEVAL_LIMIT = 100;

export type OutboundRetryDelayOptions = {
  baseMs?: number;
  capMs?: number;
  jitterRatio?: number;
  /** Injectable RNG for deterministic tests (default Math.random). */
  random?: () => number;
};

/**
 * Computes the retry delay before attempt `attemptNumber + 1` (i.e. after
 * `attemptNumber` failed attempts): `min(base · 2^(attempt−1), cap)` scaled
 * by a jitter factor in `[1 − r, 1 + r]`. Pure and deterministic under an
 * injected RNG.
 */
export function computeOutboundRetryDelayMs(
  attemptNumber: number,
  options: OutboundRetryDelayOptions = {},
): number {
  const baseMs = options.baseMs ?? OUTBOUND_RETRY_BASE_MS;
  const capMs = options.capMs ?? OUTBOUND_RETRY_CAP_MS;
  const jitterRatio = options.jitterRatio ?? OUTBOUND_RETRY_JITTER_RATIO;
  const random = options.random ?? Math.random;

  const attempts = Math.max(1, Math.trunc(attemptNumber));
  const deterministic = Math.min(baseMs * 2 ** (attempts - 1), capMs);
  const jitter = 1 + (random() * 2 - 1) * jitterRatio;
  return Math.max(1, Math.round(deterministic * jitter));
}

// ---------------------------------------------------------------------------
// Operational event vocabulary (governance §10)
// ---------------------------------------------------------------------------

export const OUTBOUND_DELIVERY_EVENT_TYPES = {
  SENT: 'NOTIFICATION_OUTBOUND_SENT',
  FAILED_RETRYABLE: 'NOTIFICATION_OUTBOUND_FAILED_RETRYABLE',
  FAILED_PERMANENT: 'NOTIFICATION_OUTBOUND_FAILED_PERMANENT',
  EXHAUSTED: 'NOTIFICATION_OUTBOUND_EXHAUSTED',
} as const;

/**
 * Governance §10 also defines NOTIFICATION_OUTBOUND_QUEUED. That event is
 * emitted at INTENT-creation time; PART 04 deliberately does not modify the
 * PART 03 intent seam, so QUEUED stays unwired until the intent orchestration
 * is next touched (vocabulary reserved here for completeness).
 */
export const OUTBOUND_DELIVERY_QUEUED_EVENT_TYPE = 'NOTIFICATION_OUTBOUND_QUEUED';

const OUTBOUND_DELIVERY_ENTITY_TYPE = 'NOTIFICATION_DELIVERY';

// ---------------------------------------------------------------------------
// Single-delivery execution
// ---------------------------------------------------------------------------

/** Optional adapter overrides (test seam; defaults to the PART 01 resolvers). */
export type OutboundDeliveryAdapterOverrides = {
  EMAIL?: EmailAdapter;
  WHATSAPP?: WhatsAppAdapter;
  /**
   * CR-BE-PUSH-01 PART 03C — push provider port override (test seam).
   *
   * Typed THROUGH the dispatch seam's own option type rather than by naming
   * the PART 02 interface directly: this service delegates all provider
   * knowledge to `outbound-push-dispatch.service`, and keeping the provider
   * vocabulary confined to that one file is exactly what boundary guard
   * B-01i requires. Production resolves the port fail-closed inside the
   * dispatch seam; nothing here ever constructs one.
   */
  PUSH?: NonNullable<ExecutePushFanoutOptions['adapter']>;
};

/** Outcome of one execution attempt on one ledger row. */
export type OutboundDeliveryExecutionOutcome =
  | { kind: 'NOT_FOUND' }
  | { kind: 'NOT_CLAIMABLE'; status: OutboundDeliveryRecord['status'] }
  /**
   * CR-BE-PUSH-01 PART 03A — the row's channel has no send path yet, so the
   * row was deliberately NOT claimed and NOT touched. It stays exactly as it
   * was (claimable, due, full retry budget) until the PART that owns its send
   * path lands. This is a deferral, never a failure and never a success.
   */
  | { kind: 'CHANNEL_NOT_EXECUTABLE'; channel: OutboundDeliveryChannel }
  | { kind: 'SENT'; record: OutboundDeliveryRecord }
  | { kind: 'RETRY_SCHEDULED'; record: OutboundDeliveryRecord; nextRetryAt: Date }
  | { kind: 'FAILED_PERMANENT'; record: OutboundDeliveryRecord }
  | { kind: 'EXHAUSTED'; record: OutboundDeliveryRecord };

/** Raw adapter interaction result, normalized for the execution path. */
type AdapterInteraction = {
  outcome: DeliveryProviderOutcome;
  provider: string;
  providerMessageId: string | null;
  providerReference: string | null;
  sentAt: Date | null;
  /** Sanitized error text (credential redaction applied), null on success. */
  error: string | null;
};

function sanitizeFor(channel: OutboundDeliveryChannel, message: string): string {
  if (channel === 'EMAIL') {
    return sanitizeEmailError(message);
  }
  // CR-BE-PUSH-01 PART 04B (§18 item 15) — this branch IS reachable: the
  // fan-out's catch routes a thrown error here. PART 03C assumed every push
  // string had already been redacted inside the provider module, but that only
  // holds for errors the per-device send classified or caught. A throw raised
  // BEFORE/AROUND that seam — port resolution reading service-account
  // configuration, plan resolution, an evidence write — never passes through
  // the per-device catch, so it would have been persisted verbatim as the
  // ledger's `last_error`.
  //
  // Applying the WhatsApp sanitizer here would be the wrong channel's rules,
  // so the provider-neutral sanitizer is reused instead. It is the SAME
  // function the adapter and the dispatch seam already use — redaction logic
  // is reused, never duplicated — and it is idempotent, so strings that were
  // already scrubbed pass through unchanged.
  if (channel === 'PUSH') {
    return sanitizeProviderError(message);
  }
  return sanitizeWhatsAppError(message);
}

/**
 * The channels this execution seam can actually send.
 *
 * CR-BE-PUSH-01 PART 03A introduced this set and left PUSH out of it, because
 * PUSH had no fan-out and no provider port wired. PART 03C completes both, so
 * PUSH joins the set and is no longer deferred. The set stays explicit: a
 * newly admitted channel is DEFERRED rather than silently mis-executed as
 * email or WhatsApp.
 */
const EXECUTABLE_CHANNELS: readonly OutboundDeliveryChannel[] = [
  'EMAIL',
  'WHATSAPP',
  'PUSH',
];

function isExecutableChannel(channel: OutboundDeliveryChannel): boolean {
  return EXECUTABLE_CHANNELS.includes(channel);
}

/**
 * Calls the channel adapter and normalizes the interaction into the PART 01
 * taxonomy. An adapter THROW is classified ERROR_UNKNOWN (governance §3.3) —
 * never a silent loss and never an unbounded retry: the attempt budget still
 * applies.
 */
/** Channel-typed send results (structurally identical, kept separate for TS). */
type SendResultLike = {
  status: 'SENT' | 'FAILED';
  providerReference?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
  retryable?: boolean;
  sentAt: Date;
};

async function runAdapter(
  record: OutboundDeliveryRecord,
  adapters?: OutboundDeliveryAdapterOverrides,
): Promise<AdapterInteraction> {
  // CR-BE-PUSH-01 PART 03C — PUSH is a fan-out, not a single send: one ledger
  // row becomes N provider calls (one per ACTIVE device) plus N evidence
  // rows. The dispatch seam performs all of that and returns ONE rolled-up
  // classification in this same taxonomy, so everything downstream — the
  // retry engine, the status transitions, the operational events — is shared
  // verbatim with EMAIL and WhatsApp. This branch returns BEFORE the
  // email/WhatsApp resolution below, so neither of those paths is altered.
  if (record.channel === 'PUSH') {
    return runPushFanout(record, adapters?.PUSH);
  }

  // Resolve the channel adapter ONCE per attempt (override → PART 01 resolver).
  const emailAdapter: EmailAdapter | undefined =
    record.channel === 'EMAIL' ? (adapters?.EMAIL ?? resolveEmailAdapter()) : undefined;
  const whatsappAdapter: WhatsAppAdapter | undefined =
    record.channel === 'WHATSAPP' ? (adapters?.WHATSAPP ?? resolveWhatsAppAdapter()) : undefined;
  const providerName = (emailAdapter ?? whatsappAdapter)!.provider;

  try {
    const result: SendResultLike = emailAdapter
      ? await emailAdapter.send({
          to: record.recipientAddress,
          subject: record.subject ?? record.message,
          body: record.message,
        })
      : // CR-BE-NOTIFY-PROV-01 PART 06: the ledger's template key lets
        // template-requiring providers (Meta approved templates) map the send.
        await whatsappAdapter!.send({
          to: record.recipientAddress,
          message: record.message,
          templateKey: record.templateKey,
        });

    const outcome = classifyProviderResult(result);
    return {
      outcome,
      provider: providerName,
      providerMessageId: result.providerMessageId ?? null,
      providerReference: result.providerReference ?? null,
      sentAt: result.status === 'SENT' ? result.sentAt : null,
      error:
        result.status === 'FAILED'
          ? sanitizeFor(record.channel, result.error ?? 'Outbound delivery failed.')
          : null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: 'ERROR_UNKNOWN',
      provider: providerName,
      providerMessageId: null,
      providerReference: null,
      sentAt: null,
      error: sanitizeFor(record.channel, message),
    };
  }
}

/**
 * CR-BE-PUSH-01 PART 03C — runs the push fan-out and flattens its rolled-up
 * result into the shared `AdapterInteraction` shape.
 *
 * A `null` plan means the row is not fan-out-able (channel mismatch, or a
 * `recipient_address` that does not parse as `user:<uuid>`). That is a data
 * defect, not a provider problem, so it is REJECTED_PERMANENT: no retry can
 * repair a malformed recipient reference, and guessing one is forbidden.
 */
async function runPushFanout(
  record: OutboundDeliveryRecord,
  adapter?: OutboundDeliveryAdapterOverrides['PUSH'],
): Promise<AdapterInteraction> {
  try {
    const execution = await executePushFanout(record, adapter ? { adapter } : {});
    if (!execution) {
      return {
        outcome: 'REJECTED_PERMANENT',
        provider: 'push',
        providerMessageId: null,
        providerReference: null,
        sentAt: null,
        error: 'Push delivery has no resolvable recipient device reference.',
      };
    }
    // CR-BE-PUSH-01 PART 04A (§8) — the fan-out has now RECORDED one evidence
    // row per device. Reconcile that written evidence against the registry so
    // devices the provider proved are dead stop being fanned out to. This
    // reads the evidence table; it never re-contacts the provider, and it
    // cannot change this delivery's outcome (§8 item 4: one dead device does
    // not fail the recipient's delivery), so a failure to reconcile must not
    // corrupt an otherwise good send.
    // CR-BE-PUSH-01 PART 04B (§6-7) — fold THIS attempt's per-device outcomes
    // into the PART 01 health counters. Runs before reconciliation so that an
    // INVALID_TOKEN attempt is counted exactly once, by PART 04A's invalidating
    // UPDATE, rather than here as well. Telemetry never changes the ledger
    // outcome and never throws.
    await recordPushAttemptTelemetry(execution.attempts);

    if (execution.invalidTokens > 0) {
      try {
        await reconcileInvalidTokenEvidence(record.id);
      } catch (reconcileError) {
        logger.error(
          `Push token invalidation reconciliation failed for ${record.id}: ${
            reconcileError instanceof Error
              ? reconcileError.message
              : String(reconcileError)
          }`,
        );
      }
    }

    return {
      outcome: execution.outcome,
      provider: execution.provider,
      providerMessageId: execution.providerMessageId,
      providerReference: execution.providerMessageId,
      sentAt: execution.sentAt,
      error: execution.error,
    };
  } catch (error) {
    // Matches the EMAIL/WhatsApp contract: a throw is ERROR_UNKNOWN, never a
    // silent loss and never an unbounded retry — the attempt budget applies.
    const message = error instanceof Error ? error.message : String(error);
    return {
      outcome: 'ERROR_UNKNOWN',
      provider: 'push',
      providerMessageId: null,
      providerReference: null,
      sentAt: null,
      error: sanitizeFor(record.channel, message),
    };
  }
}

/**
 * Writes the immutable attempt-history row for this adapter call into the
 * channel's BE-26F/G table, linked to the ledger via delivery_id (migration
 * 0299). One row per adapter call — success or failure.
 *
 * CR-BE-PUSH-01 PART 03C — PUSH is the exception to "one row per call": the
 * dispatch seam already wrote one `notification_push_deliveries` row per
 * DEVICE, which is the correct granularity for a fan-out (§10.2). Writing an
 * additional recipient-level row here would double-count the attempt and
 * imply a single address push does not have.
 */
async function recordAttemptHistory(
  record: OutboundDeliveryRecord,
  interaction: AdapterInteraction,
): Promise<void> {
  if (record.channel === 'PUSH') {
    return;
  }

  const sent = interaction.outcome === 'ACCEPTED';
  const providerReference =
    interaction.providerMessageId ?? interaction.providerReference ?? null;

  if (record.channel === 'EMAIL') {
    await emailDeliveryRepository.create({
      clientId: record.clientId,
      recipientUserId: record.recipientUserId,
      recipientEmail: record.recipientAddress,
      templateKey: record.templateKey,
      subject: record.subject ?? record.message,
      body: record.message,
      status: sent ? 'SENT' : 'FAILED',
      provider: interaction.provider,
      providerReference,
      errorMessage: sent ? null : interaction.error,
      sentAt: sent ? interaction.sentAt : null,
      deliveryId: record.id,
    });
    return;
  }

  await whatsappDeliveryRepository.create({
    clientId: record.clientId,
    recipientUserId: record.recipientUserId,
    recipientPhone: record.recipientAddress,
    templateKey: record.templateKey,
    messageBody: record.message,
    status: sent ? 'SENT' : 'FAILED',
    provider: interaction.provider,
    providerReference,
    errorMessage: sent ? null : interaction.error,
    sentAt: sent ? interaction.sentAt : null,
    deliveryId: record.id,
  });
}

/** Emits the governance §10 operational event for one lifecycle transition. */
async function recordOutboundDeliveryEvent(
  eventType: string,
  record: OutboundDeliveryRecord,
  detail: { provider: string | null; attemptCount: number; error?: string | null },
): Promise<void> {
  await recordOperationalEvent({
    clientId: record.clientId,
    eventType,
    entityType: OUTBOUND_DELIVERY_ENTITY_TYPE,
    entityId: record.id,
    buildingId: record.buildingId,
    summary: `Outbound ${record.channel} delivery ${eventType.replace('NOTIFICATION_OUTBOUND_', '').toLowerCase()} (attempt ${detail.attemptCount}, provider ${detail.provider ?? 'unknown'})`,
    metadata: {
      channel: record.channel,
      provider: detail.provider,
      attemptCount: detail.attemptCount,
      templateKey: record.templateKey,
      ...(detail.error ? { error: detail.error } : {}),
    },
  });
}

/**
 * Executes ONE ledger delivery: claim → adapter send → attempt-history row →
 * guarded result transition → operational event.
 *
 * At-most-once by construction (governance §7.1): a caller that does not win
 * the guarded claim performs no side effect. `adapters` overrides exist for
 * deterministic tests (the production path resolves via EMAIL_PROVIDER /
 * WHATSAPP_PROVIDER, PART 01).
 */
export async function processOutboundDelivery(
  id: string,
  at: Date = new Date(),
  adapters?: OutboundDeliveryAdapterOverrides,
): Promise<OutboundDeliveryExecutionOutcome> {
  // CR-BE-PUSH-01 PART 03A — send-path gate, evaluated BEFORE the claim.
  //
  // PART 03A widens the ledger to admit PUSH intents; the PUSH send path
  // (device fan-out + the PART 02 provider port) is PART 03B. Until it
  // lands, a PUSH row must never be claimed: claiming it would move it to
  // SENDING, and the adapter resolution below has no PUSH branch, so the row
  // would be stranded in SENDING with no owner, outside the retry budget and
  // invisible to the next pass.
  //
  // Checking before the claim keeps the row untouched and fully replayable:
  // no status change, no attempt consumed, no attempt-history row, no
  // operational event, no provider contact, and no fabricated outcome. The
  // row simply waits. EMAIL and WHATSAPP never reach this branch.
  const pending = await ledgerRepository.findById(id);
  if (pending && !isExecutableChannel(pending.channel)) {
    return { kind: 'CHANNEL_NOT_EXECUTABLE', channel: pending.channel };
  }

  const claimed = await ledgerRepository.claimDelivery(id, at);
  if (!claimed) {
    const existing = await ledgerRepository.findById(id);
    return existing
      ? { kind: 'NOT_CLAIMABLE', status: existing.status }
      : { kind: 'NOT_FOUND' };
  }

  const interaction = await runAdapter(claimed, adapters);
  await recordAttemptHistory(claimed, interaction);

  // The attempt this execution performed (ledger SQL increments on write).
  const attemptNumber = claimed.attemptCount + 1;

  if (interaction.outcome === 'ACCEPTED') {
    const record = await ledgerRepository.markSent(id, {
      attemptedAt: at,
      provider: interaction.provider,
      providerMessageId: interaction.providerMessageId,
    });
    if (record) {
      await recordOutboundDeliveryEvent(OUTBOUND_DELIVERY_EVENT_TYPES.SENT, record, {
        provider: record.provider,
        attemptCount: record.attemptCount,
      });
      return { kind: 'SENT', record };
    }
    // The guard matched nothing (should not happen for the claim owner);
    // report the row as-is without further side effects.
    const current = await ledgerRepository.findById(id);
    return current
      ? { kind: 'NOT_CLAIMABLE', status: current.status }
      : { kind: 'NOT_FOUND' };
  }

  const permanent = interaction.outcome === 'REJECTED_PERMANENT';
  const exhausted = !permanent && attemptNumber >= claimed.maxAttempts;

  if (permanent || exhausted) {
    const record = permanent
      ? await ledgerRepository.markFailedPermanent(id, {
          attemptedAt: at,
          provider: interaction.provider,
          providerMessageId: interaction.providerMessageId,
          error: interaction.error,
        })
      : await ledgerRepository.markExhausted(id, {
          attemptedAt: at,
          provider: interaction.provider,
          providerMessageId: interaction.providerMessageId,
          error: interaction.error,
        });
    if (record) {
      await recordOutboundDeliveryEvent(
        permanent
          ? OUTBOUND_DELIVERY_EVENT_TYPES.FAILED_PERMANENT
          : OUTBOUND_DELIVERY_EVENT_TYPES.EXHAUSTED,
        record,
        { provider: record.provider, attemptCount: record.attemptCount, error: record.lastError },
      );
      return { kind: permanent ? 'FAILED_PERMANENT' : 'EXHAUSTED', record };
    }
    const current = await ledgerRepository.findById(id);
    return current
      ? { kind: 'NOT_CLAIMABLE', status: current.status }
      : { kind: 'NOT_FOUND' };
  }

  // REJECTED_RETRYABLE or ERROR_UNKNOWN with attempts remaining (§3.3).
  const delayMs = computeOutboundRetryDelayMs(attemptNumber);
  const nextRetryAt = new Date(at.getTime() + delayMs);
  const record = await ledgerRepository.markRetryScheduled(id, {
    attemptedAt: at,
    nextRetryAt,
    provider: interaction.provider,
    providerMessageId: interaction.providerMessageId,
    error: interaction.error,
  });
  if (!record) {
    const current = await ledgerRepository.findById(id);
    return current
      ? { kind: 'NOT_CLAIMABLE', status: current.status }
      : { kind: 'NOT_FOUND' };
  }
  await recordOutboundDeliveryEvent(
    OUTBOUND_DELIVERY_EVENT_TYPES.FAILED_RETRYABLE,
    record,
    { provider: record.provider, attemptCount: record.attemptCount, error: record.lastError },
  );
  return { kind: 'RETRY_SCHEDULED', record, nextRetryAt };
}

// ---------------------------------------------------------------------------
// Due-window execution (dispatcher domain)
// ---------------------------------------------------------------------------

/** Aggregate of one bounded due-execution pass (for the dispatcher + tests). */
export type OutboundDeliveryDispatchResult = {
  /** Rows enumerated as due this pass. */
  due: number;
  /** Attempts that completed as SENT. */
  sent: number;
  /** Attempts scheduled for retry (transient / unknown with budget left). */
  retryScheduled: number;
  /** Attempts that failed permanently. */
  failedPermanent: number;
  /** Attempts that exhausted the retry budget. */
  exhausted: number;
  /** Due rows whose claim was lost to a concurrent runner (stay due). */
  skipped: number;
  /**
   * CR-BE-PUSH-01 PART 03A — due rows left untouched because their channel
   * has no send path yet (PUSH until PART 03B). Counted separately from
   * `skipped` so a deferral is never mistaken for lock contention, and never
   * reported as a send.
   */
  deferred: number;
  /** Rows that threw unexpectedly (isolated; counted, never swallowed). */
  failures: number;
};

/**
 * One bounded execution pass over the due outbound backlog.
 *
 * Enumeration runs in its own short transaction so `FOR UPDATE SKIP LOCKED`
 * has a transaction to hold its locks in (SLA-02 dispatcher precedent); the
 * guarded claim remains the authoritative mutual exclusion. Failure is
 * isolated per row: one bad row can never stop the rest of the batch, and
 * leftovers stay due for the next pass. Safe on an empty due window.
 */
export async function processDueOutboundDeliveries(
  before: Date = new Date(),
  limit: number = OUTBOUND_DUE_RETRIEVAL_LIMIT,
  adapters?: OutboundDeliveryAdapterOverrides,
): Promise<OutboundDeliveryDispatchResult> {
  const due = await withTransaction((tx) =>
    ledgerRepository.findDueDeliveries(before, limit, tx),
  );

  const result: OutboundDeliveryDispatchResult = {
    due: due.length,
    sent: 0,
    retryScheduled: 0,
    failedPermanent: 0,
    exhausted: 0,
    skipped: 0,
    deferred: 0,
    failures: 0,
  };

  for (const delivery of due) {
    try {
      const outcome = await processOutboundDelivery(delivery.id, before, adapters);
      switch (outcome.kind) {
        case 'SENT':
          result.sent += 1;
          break;
        case 'RETRY_SCHEDULED':
          result.retryScheduled += 1;
          break;
        case 'FAILED_PERMANENT':
          result.failedPermanent += 1;
          break;
        case 'EXHAUSTED':
          result.exhausted += 1;
          break;
        case 'NOT_CLAIMABLE':
        case 'NOT_FOUND':
          result.skipped += 1;
          break;
        case 'CHANNEL_NOT_EXECUTABLE':
          // Left untouched and still due; no attempt was consumed.
          result.deferred += 1;
          break;
      }
    } catch (error) {
      result.failures += 1;
      logger.error(
        `Outbound delivery execution failed unexpectedly for ${delivery.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}

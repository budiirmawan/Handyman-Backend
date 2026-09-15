import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import { clampDueItemLimit } from '../../shared/due-retrieval';
import type {
  NewOutboundDelivery,
  OutboundDeliveryAttemptOutcome,
  OutboundDeliveryChannel,
  OutboundDeliveryCreateResult,
  OutboundDeliveryFeedbackInput,
  OutboundDeliveryRecord,
  OutboundDeliveryRetryOutcome,
} from './outbound-delivery.types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 02 — outbound delivery ledger repository.
 *
 * The guarded seams over `notification_outbound_deliveries`, shaped after the
 * BE-26I / CR-BE-SLA-02 claim-before-send pattern:
 *
 *   - idempotent creation (insert-on-conflict-return),
 *   - bounded due enumeration with `FOR UPDATE SKIP LOCKED`,
 *   - the guarded claim (PENDING/RETRY_SCHEDULED → SENDING),
 *   - guarded result seams (SENDING → SENT / RETRY_SCHEDULED /
 *     FAILED_PERMANENT / EXHAUSTED).
 *
 * Every transition is a status-guarded single UPDATE returning the row (or
 * null when the guard matched nothing), so exactly one caller can ever own a
 * given transition and every seam is safe to re-invoke. No orchestration,
 * adapter call, or retry policy lives here — PART 03/04 are the callers.
 */

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<Pool | PoolClient, 'query'>;

const A = `id,client_id AS "clientId",building_id AS "buildingId",recipient_user_id AS "recipientUserId",channel,template_key AS "templateKey",source_event_type AS "sourceEventType",source_entity_type AS "sourceEntityType",source_entity_id AS "sourceEntityId",subject,message,recipient_address AS "recipientAddress",status,attempt_count AS "attemptCount",max_attempts AS "maxAttempts",next_retry_at AS "nextRetryAt",last_attempt_at AS "lastAttemptAt",provider,provider_message_id AS "providerMessageId",last_error AS "lastError",provider_feedback_status AS "providerFeedbackStatus",feedback_at AS "feedbackAt",feedback_error AS "feedbackError",idempotency_key AS "idempotencyKey",created_at AS "createdAt",updated_at AS "updatedAt"`;

/**
 * Idempotent creation seam (governance §7.1).
 *
 * Inserts one PENDING ledger row. On an idempotency-key collision
 * (`UNIQUE (client_id, channel, idempotency_key)`) nothing is inserted and
 * the EXISTING row is returned with `created: false` — a replayed intent can
 * never create a second delivery, and the original snapshot is never
 * overwritten by the replay's payload.
 */
async function createOnConflictReturn(
  input: NewOutboundDelivery,
  q: Q = getPool(),
): Promise<OutboundDeliveryCreateResult> {
  const inserted = await q.query<OutboundDeliveryRecord>(
    `INSERT INTO notification_outbound_deliveries (
       id, client_id, building_id, recipient_user_id, channel, template_key,
       source_event_type, source_entity_type, source_entity_id,
       subject, message, recipient_address, idempotency_key${input.maxAttempts === undefined ? '' : ', max_attempts'}
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9,
       $10, $11, $12, $13${input.maxAttempts === undefined ? '' : ', $14'}
     )
     ON CONFLICT ON CONSTRAINT notification_outbound_deliveries_idempotency_unique
       DO NOTHING
     RETURNING ${A}`,
    input.maxAttempts === undefined
      ? [
          randomUUID(),
          input.clientId,
          input.buildingId ?? null,
          input.recipientUserId,
          input.channel,
          input.templateKey ?? null,
          input.sourceEventType,
          input.sourceEntityType,
          input.sourceEntityId,
          input.subject ?? null,
          input.message,
          input.recipientAddress,
          input.idempotencyKey,
        ]
      : [
          randomUUID(),
          input.clientId,
          input.buildingId ?? null,
          input.recipientUserId,
          input.channel,
          input.templateKey ?? null,
          input.sourceEventType,
          input.sourceEntityType,
          input.sourceEntityId,
          input.subject ?? null,
          input.message,
          input.recipientAddress,
          input.idempotencyKey,
          input.maxAttempts,
        ],
  );

  if (inserted.rows[0]) {
    return { record: inserted.rows[0], created: true };
  }

  const existing = await findByIdempotencyKey(
    input.clientId,
    input.channel,
    input.idempotencyKey,
    q,
  );
  if (!existing) {
    // The conflict was observed but the row is not readable on this executor —
    // fail loudly rather than silently reporting a creation.
    throw new Error(
      'Outbound delivery idempotency conflict: the conflicting row could not be read back.',
    );
  }
  return { record: existing, created: false };
}

/** Read seam by the idempotency identity (client + channel + key). */
async function findByIdempotencyKey(
  clientId: string,
  channel: OutboundDeliveryChannel,
  idempotencyKey: string,
  q: Q = getPool(),
): Promise<OutboundDeliveryRecord | null> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `SELECT ${A} FROM notification_outbound_deliveries
        WHERE client_id=$1 AND channel=$2 AND idempotency_key=$3`,
      [clientId, channel, idempotencyKey],
    )
  ).rows[0] ?? null;
}

/** Single-ledger-row read seam (executor-aware). */
async function findById(
  id: string,
  q: Q = getPool(),
): Promise<OutboundDeliveryRecord | null> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `SELECT ${A} FROM notification_outbound_deliveries WHERE id=$1`,
      [id],
    )
  ).rows[0] ?? null;
}

/**
 * Due-window enumeration (mirrors `findDueActions` on `sla_escalation_actions`
 * and BE-26I's `findDue`).
 *
 * A claimable row is due when its retry window has elapsed: PENDING rows
 * carry no `next_retry_at` and are immediately due; RETRY_SCHEDULED rows are
 * due at `next_retry_at <= before`. Terminal statuses never enumerate.
 * Deterministically ordered, bounded by the shared `clampDueItemLimit` so one
 * pass can never load an unbounded backlog after an outage, and protected by
 * `FOR UPDATE SKIP LOCKED` so concurrent workers skip rows another worker
 * already holds (the guarded claim remains the authoritative primitive).
 */
async function findDueDeliveries(
  before: Date,
  limit: number | undefined,
  q: Q,
): Promise<OutboundDeliveryRecord[]> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `SELECT ${A} FROM notification_outbound_deliveries
        WHERE status IN ('PENDING', 'RETRY_SCHEDULED')
          AND COALESCE(next_retry_at, '-infinity'::timestamptz) <= $1
        ORDER BY COALESCE(next_retry_at, '-infinity'::timestamptz) ASC, id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      [before, clampDueItemLimit(limit)],
    )
  ).rows;
}

/**
 * Claim-before-send (BE-26I / SLA-02 pattern).
 *
 * The guarded claimable → SENDING transition. Exactly one caller can ever
 * receive a row for a given delivery: PostgreSQL serializes the concurrent
 * UPDATEs on the row, and the loser re-evaluates the status guard against the
 * winner's committed value and matches nothing. A `null` return means someone
 * else owns this delivery and the caller MUST NOT contact an adapter.
 */
async function claimDelivery(
  id: string,
  at: Date,
  q: Q = getPool(),
): Promise<OutboundDeliveryRecord | null> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `UPDATE notification_outbound_deliveries
          SET status='SENDING', last_attempt_at=$2, updated_at=NOW()
        WHERE id=$1 AND status IN ('PENDING', 'RETRY_SCHEDULED')
        RETURNING ${A}`,
      [id, at],
    )
  ).rows[0] ?? null;
}

/**
 * Guarded terminal success seam: SENDING → SENT.
 *
 * Records the attempt outcome (`attempt_count += 1`, provider fields, cleared
 * retry window and error). Guarded on `status='SENDING'` so only the claim
 * owner can write the outcome; a `null` return means the guard matched
 * nothing and no state changed.
 */
async function markSent(
  id: string,
  outcome: OutboundDeliveryAttemptOutcome,
  q: Q = getPool(),
): Promise<OutboundDeliveryRecord | null> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `UPDATE notification_outbound_deliveries
          SET status='SENT',
              attempt_count=attempt_count + 1,
              last_attempt_at=$2,
              provider=COALESCE($3, provider),
              provider_message_id=COALESCE($4, provider_message_id),
              last_error=NULL,
              next_retry_at=NULL,
              updated_at=NOW()
        WHERE id=$1 AND status='SENDING'
        RETURNING ${A}`,
      [id, outcome.attemptedAt, outcome.provider ?? null, outcome.providerMessageId ?? null],
    )
  ).rows[0] ?? null;
}

/**
 * Guarded retry seam: SENDING → RETRY_SCHEDULED.
 *
 * Records the failed attempt and the durable retry window
 * (`next_retry_at`); the retry engine (PART 04) picks the row up again
 * through the due enumeration. Guarded on `status='SENDING'`.
 */
async function markRetryScheduled(
  id: string,
  outcome: OutboundDeliveryRetryOutcome,
  q: Q = getPool(),
): Promise<OutboundDeliveryRecord | null> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `UPDATE notification_outbound_deliveries
          SET status='RETRY_SCHEDULED',
              attempt_count=attempt_count + 1,
              last_attempt_at=$2,
              next_retry_at=$3,
              provider=COALESCE($4, provider),
              provider_message_id=COALESCE($5, provider_message_id),
              last_error=$6,
              updated_at=NOW()
        WHERE id=$1 AND status='SENDING'
        RETURNING ${A}`,
      [
        id,
        outcome.attemptedAt,
        outcome.nextRetryAt,
        outcome.provider ?? null,
        outcome.providerMessageId ?? null,
        outcome.error ?? null,
      ],
    )
  ).rows[0] ?? null;
}

/**
 * Guarded permanent-failure seam: SENDING → FAILED_PERMANENT.
 *
 * Terminal: a validation/policy reject can never become due again. Guarded on
 * `status='SENDING'`.
 */
async function markFailedPermanent(
  id: string,
  outcome: OutboundDeliveryAttemptOutcome,
  q: Q = getPool(),
): Promise<OutboundDeliveryRecord | null> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `UPDATE notification_outbound_deliveries
          SET status='FAILED_PERMANENT',
              attempt_count=attempt_count + 1,
              last_attempt_at=$2,
              provider=COALESCE($3, provider),
              provider_message_id=COALESCE($4, provider_message_id),
              last_error=$5,
              next_retry_at=NULL,
              updated_at=NOW()
        WHERE id=$1 AND status='SENDING'
        RETURNING ${A}`,
      [
        id,
        outcome.attemptedAt,
        outcome.provider ?? null,
        outcome.providerMessageId ?? null,
        outcome.error ?? null,
      ],
    )
  ).rows[0] ?? null;
}

/**
 * Guarded exhaustion seam: SENDING → EXHAUSTED.
 *
 * Terminal: the attempt budget ran out on retryable failures. Guarded on
 * `status='SENDING'`; `attempt_count` increments with the final attempt.
 */
async function markExhausted(
  id: string,
  outcome: OutboundDeliveryAttemptOutcome,
  q: Q = getPool(),
): Promise<OutboundDeliveryRecord | null> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `UPDATE notification_outbound_deliveries
          SET status='EXHAUSTED',
              attempt_count=attempt_count + 1,
              last_attempt_at=$2,
              provider=COALESCE($3, provider),
              provider_message_id=COALESCE($4, provider_message_id),
              last_error=$5,
              next_retry_at=NULL,
              updated_at=NOW()
        WHERE id=$1 AND status='SENDING'
        RETURNING ${A}`,
      [
        id,
        outcome.attemptedAt,
        outcome.provider ?? null,
        outcome.providerMessageId ?? null,
        outcome.error ?? null,
      ],
    )
  ).rows[0] ?? null;
}

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — provider message-id correlation seam.
 *
 * Finds the ledger row for a provider message reference (the Meta `wamid`
 * for WhatsApp). Backed by the PART 07 partial index on
 * `provider_message_id`. Returns the newest match when several exist
 * (retries overwrite the reference with the latest attempt's id).
 */
async function findByProviderMessageId(
  providerMessageId: string,
  q: Q = getPool(),
): Promise<OutboundDeliveryRecord | null> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `SELECT ${A} FROM notification_outbound_deliveries
        WHERE provider_message_id=$1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [providerMessageId],
    )
  ).rows[0] ?? null;
}

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — guarded delivery feedback transition.
 *
 * Post-acceptance feedback annotates a SENT delivery WITHOUT ever reopening
 * the send lifecycle: the guarded source is `status='SENT'` combined with
 * `provider_feedback_status IS NULL`, so
 *   - only the first accepted feedback writes (duplicates are no-ops),
 *   - out-of-order callbacks (a late `failed` after `delivered`) are no-ops,
 *   - no claimable/retry state is reachable from feedback.
 * Returns the updated row, or `null` when the guard matched nothing.
 */
async function applyDeliveryFeedback(
  id: string,
  feedback: OutboundDeliveryFeedbackInput,
  q: Q = getPool(),
): Promise<OutboundDeliveryRecord | null> {
  return (
    await q.query<OutboundDeliveryRecord>(
      `UPDATE notification_outbound_deliveries
          SET provider_feedback_status=$2,
              feedback_at=$3,
              feedback_error=$4,
              updated_at=NOW()
        WHERE id=$1 AND status='SENT' AND provider_feedback_status IS NULL
        RETURNING ${A}`,
      [id, feedback.feedbackStatus, feedback.feedbackAt, feedback.feedbackError ?? null],
    )
  ).rows[0] ?? null;
}

export const notificationOutboundDeliveryRepository = {
  applyDeliveryFeedback,
  claimDelivery,
  createOnConflictReturn,
  findById,
  findByIdempotencyKey,
  findByProviderMessageId,
  findDueDeliveries,
  markExhausted,
  markFailedPermanent,
  markRetryScheduled,
  markSent,
};

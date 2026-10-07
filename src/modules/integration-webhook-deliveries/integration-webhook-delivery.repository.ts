import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../../database';
import { clampDueItemLimit } from '../../shared/due-retrieval';
import type {
  IntegrationWebhookDeliveryAttemptOutcome,
  IntegrationWebhookDeliveryCreateResult,
  IntegrationWebhookDeliveryListFilters,
  IntegrationWebhookDeliveryRecord,
  IntegrationWebhookDeliveryRetryOutcome,
  NewIntegrationWebhookDelivery,
} from './integration-webhook-delivery.types';

/**
 * CR-BE-INTEG-01 PART 03 — webhook delivery ledger repository.
 *
 * The guarded seams over `integration_webhook_deliveries`, cloned from the
 * proven CR-BE-NOTIFY-PROV-01 ledger pattern:
 *
 *   - idempotent fan-out creation (insert-on-conflict-return on
 *     `UNIQUE (outbox_event_id, endpoint_id)`),
 *   - bounded due enumeration with `FOR UPDATE SKIP LOCKED`,
 *   - the guarded claim (PENDING/RETRY_SCHEDULED → SENDING),
 *   - guarded result seams (SENDING → DELIVERED / RETRY_SCHEDULED /
 *     FAILED_PERMANENT / EXHAUSTED).
 *
 * Every transition is a status-guarded single UPDATE returning the row (or
 * null when the guard matched nothing), so exactly one caller can ever own a
 * given transition. No HTTP contact, signing, retry policy, or scheduler
 * concern lives here — PART 04+ are the callers of claim/result.
 */

/** Any executor: the pool, or the caller's open transaction client. */
type Q = Pick<Pool | PoolClient, 'query'>;

const A = `id,
  outbox_event_id AS "outboxEventId",
  endpoint_id AS "endpointId",
  client_id AS "clientId",
  building_id AS "buildingId",
  event_type AS "eventType",
  status,
  attempt_count AS "attemptCount",
  max_attempts AS "maxAttempts",
  next_retry_at AS "nextRetryAt",
  last_attempt_at AS "lastAttemptAt",
  last_response_status AS "lastResponseStatus",
  last_error AS "lastError",
  delivered_at AS "deliveredAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

/**
 * Idempotent fan-out creation seam (governance §6.1 / §7).
 *
 * Inserts one PENDING delivery for an (outbox event, endpoint) pair. On a
 * conflict with the fan-out uniqueness constraint nothing is inserted and
 * the EXISTING row is returned with `created: false` — re-running fan-out
 * can never produce a duplicate delivery.
 */
async function createOnConflictReturn(
  input: NewIntegrationWebhookDelivery,
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryCreateResult> {
  const inserted = await q.query<IntegrationWebhookDeliveryRecord>(
    `INSERT INTO integration_webhook_deliveries (
       id, outbox_event_id, endpoint_id, client_id, building_id,
       event_type${input.maxAttempts === undefined ? '' : ', max_attempts'}
     )
     VALUES ($1, $2, $3, $4, $5, $6${input.maxAttempts === undefined ? '' : ', $7'})
     ON CONFLICT ON CONSTRAINT integration_webhook_deliveries_fanout_unique
       DO NOTHING
     RETURNING ${A}`,
    input.maxAttempts === undefined
      ? [
          randomUUID(),
          input.outboxEventId,
          input.endpointId,
          input.clientId,
          input.buildingId,
          input.eventType,
        ]
      : [
          randomUUID(),
          input.outboxEventId,
          input.endpointId,
          input.clientId,
          input.buildingId,
          input.eventType,
          input.maxAttempts,
        ],
  );

  if (inserted.rows[0]) {
    return { record: inserted.rows[0], created: true };
  }

  const existing = await findByFanOutIdentity(input.outboxEventId, input.endpointId, q);
  if (!existing) {
    // The conflict was observed but the row is not readable on this executor —
    // fail loudly rather than silently reporting a creation.
    throw new Error(
      'Webhook delivery fan-out conflict: the conflicting row could not be read back.',
    );
  }
  return { record: existing, created: false };
}

/** Read seam by the fan-out identity (outbox event + endpoint). */
async function findByFanOutIdentity(
  outboxEventId: string,
  endpointId: string,
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryRecord | null> {
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `SELECT ${A} FROM integration_webhook_deliveries
      WHERE outbox_event_id = $1 AND endpoint_id = $2`,
    [outboxEventId, endpointId],
  );
  return result.rows[0] ?? null;
}

/** Single-row read seam. */
async function findById(
  id: string,
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryRecord | null> {
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `SELECT ${A} FROM integration_webhook_deliveries WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** All deliveries fanned out from one outbox event (deterministic order). */
async function listByOutboxEventId(
  outboxEventId: string,
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryRecord[]> {
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `SELECT ${A} FROM integration_webhook_deliveries
      WHERE outbox_event_id = $1
      ORDER BY created_at ASC, id ASC`,
    [outboxEventId],
  );
  return result.rows;
}

/**
 * Due-window enumeration (mirrors the notification ledger): PENDING rows are
 * immediately due; RETRY_SCHEDULED rows are due at `next_retry_at <= before`.
 * Terminal statuses never enumerate. Bounded, deterministic, and protected
 * by `FOR UPDATE SKIP LOCKED` (the caller MUST hold an open transaction);
 * the guarded claim remains the authoritative ownership primitive.
 */
async function findDueDeliveries(
  before: Date,
  limit: number | undefined,
  q: Q,
): Promise<IntegrationWebhookDeliveryRecord[]> {
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `SELECT ${A} FROM integration_webhook_deliveries
      WHERE status IN ('PENDING', 'RETRY_SCHEDULED')
        AND COALESCE(next_retry_at, '-infinity'::timestamptz) <= $1
      ORDER BY COALESCE(next_retry_at, '-infinity'::timestamptz) ASC, id ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    [before, clampDueItemLimit(limit)],
  );
  return result.rows;
}

/**
 * Claim-before-send: the guarded claimable → SENDING transition. A `null`
 * return means another worker owns this delivery and the caller MUST NOT
 * contact the receiver.
 */
async function claimDelivery(
  id: string,
  at: Date,
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryRecord | null> {
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `UPDATE integration_webhook_deliveries
        SET status = 'SENDING', last_attempt_at = $2, updated_at = NOW()
      WHERE id = $1 AND status IN ('PENDING', 'RETRY_SCHEDULED')
      RETURNING ${A}`,
    [id, at],
  );
  return result.rows[0] ?? null;
}

/** Guarded terminal success seam: SENDING → DELIVERED (receiver 2xx only). */
async function markDelivered(
  id: string,
  outcome: IntegrationWebhookDeliveryAttemptOutcome,
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryRecord | null> {
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `UPDATE integration_webhook_deliveries
        SET status = 'DELIVERED',
            attempt_count = attempt_count + 1,
            last_attempt_at = $2,
            last_response_status = $3,
            last_error = NULL,
            next_retry_at = NULL,
            delivered_at = $2,
            updated_at = NOW()
      WHERE id = $1 AND status = 'SENDING'
      RETURNING ${A}`,
    [id, outcome.attemptedAt, outcome.responseStatus ?? null],
  );
  return result.rows[0] ?? null;
}

/** Guarded retry seam: SENDING → RETRY_SCHEDULED (durable due window). */
async function markRetryScheduled(
  id: string,
  outcome: IntegrationWebhookDeliveryRetryOutcome,
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryRecord | null> {
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `UPDATE integration_webhook_deliveries
        SET status = 'RETRY_SCHEDULED',
            attempt_count = attempt_count + 1,
            last_attempt_at = $2,
            next_retry_at = $3,
            last_response_status = $4,
            last_error = $5,
            updated_at = NOW()
      WHERE id = $1 AND status = 'SENDING'
      RETURNING ${A}`,
    [
      id,
      outcome.attemptedAt,
      outcome.nextRetryAt,
      outcome.responseStatus ?? null,
      outcome.error ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

/** Guarded permanent-failure seam: SENDING → FAILED_PERMANENT (terminal). */
async function markFailedPermanent(
  id: string,
  outcome: IntegrationWebhookDeliveryAttemptOutcome,
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryRecord | null> {
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `UPDATE integration_webhook_deliveries
        SET status = 'FAILED_PERMANENT',
            attempt_count = attempt_count + 1,
            last_attempt_at = $2,
            last_response_status = $3,
            last_error = $4,
            next_retry_at = NULL,
            updated_at = NOW()
      WHERE id = $1 AND status = 'SENDING'
      RETURNING ${A}`,
    [id, outcome.attemptedAt, outcome.responseStatus ?? null, outcome.error ?? null],
  );
  return result.rows[0] ?? null;
}

/** Guarded exhaustion seam: SENDING → EXHAUSTED (attempt budget spent). */
async function markExhausted(
  id: string,
  outcome: IntegrationWebhookDeliveryAttemptOutcome,
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryRecord | null> {
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `UPDATE integration_webhook_deliveries
        SET status = 'EXHAUSTED',
            attempt_count = attempt_count + 1,
            last_attempt_at = $2,
            last_response_status = $3,
            last_error = $4,
            next_retry_at = NULL,
            updated_at = NOW()
      WHERE id = $1 AND status = 'SENDING'
      RETURNING ${A}`,
    [id, outcome.attemptedAt, outcome.responseStatus ?? null, outcome.error ?? null],
  );
  return result.rows[0] ?? null;
}

/**
 * CR-BE-INTEG-01 PART 04 — stale-claim recovery (governance §4.2).
 *
 * A SENDING row orphaned by a crashed worker would otherwise be stuck
 * forever (no result seam ever fires). Rows still SENDING with
 * `last_attempt_at` older than the cutoff are conservatively recovered: the
 * orphaned attempt is COUNTED (its request may have reached the receiver),
 * then the row either returns to the due window (RETRY_SCHEDULED,
 * immediately due) or terminates (EXHAUSTED) when the counted attempt spends
 * the budget. Guarded single UPDATEs; safe to run every pass.
 */
async function recoverStaleClaims(
  olderThan: Date,
  q: Q = getPool(),
): Promise<{ retryScheduled: number; exhausted: number }> {
  const exhausted = await q.query(
    `UPDATE integration_webhook_deliveries
        SET status = 'EXHAUSTED',
            attempt_count = attempt_count + 1,
            next_retry_at = NULL,
            last_error = 'Stale SENDING claim recovered (worker crash)',
            updated_at = NOW()
      WHERE status = 'SENDING'
        AND last_attempt_at < $1
        AND attempt_count + 1 >= max_attempts`,
    [olderThan],
  );
  const retried = await q.query(
    `UPDATE integration_webhook_deliveries
        SET status = 'RETRY_SCHEDULED',
            attempt_count = attempt_count + 1,
            next_retry_at = NOW(),
            last_error = 'Stale SENDING claim recovered (worker crash)',
            updated_at = NOW()
      WHERE status = 'SENDING'
        AND last_attempt_at < $1`,
    [olderThan],
  );
  return {
    exhausted: exhausted.rowCount ?? 0,
    retryScheduled: retried.rowCount ?? 0,
  };
}

/**
 * CR-BE-INTEG-01 PART 06 — read-API enumeration, ALWAYS bounded to an
 * explicit accessible-Client set (empty set returns nothing — isolation is
 * structural). Newest first (delivery history semantics). The shared WHERE
 * is used by both the page and the count seam so they can never disagree.
 */
const LIST_WHERE = `client_id = ANY($1::uuid[])
        AND ($2::uuid IS NULL OR client_id = $2)
        AND ($3::uuid IS NULL OR endpoint_id = $3)
        AND ($4::text IS NULL OR status = $4)
        AND ($5::text IS NULL OR event_type = UPPER($5))
        AND ($6::timestamptz IS NULL OR created_at >= $6)
        AND ($7::timestamptz IS NULL OR created_at <= $7)`;

function listParams(
  accessibleClientIds: readonly string[],
  filters: IntegrationWebhookDeliveryListFilters,
): unknown[] {
  return [
    accessibleClientIds,
    filters.clientId ?? null,
    filters.endpointId ?? null,
    filters.status ?? null,
    filters.eventType ?? null,
    filters.from ?? null,
    filters.to ?? null,
  ];
}

async function listForClients(
  accessibleClientIds: readonly string[],
  filters: IntegrationWebhookDeliveryListFilters,
  page?: { limit: number; offset: number },
  q: Q = getPool(),
): Promise<IntegrationWebhookDeliveryRecord[]> {
  const params = listParams(accessibleClientIds, filters);
  if (page) {
    const result = await q.query<IntegrationWebhookDeliveryRecord>(
      `SELECT ${A} FROM integration_webhook_deliveries
        WHERE ${LIST_WHERE}
        ORDER BY created_at DESC, id DESC
        LIMIT $8 OFFSET $9`,
      [...params, page.limit, page.offset],
    );
    return result.rows;
  }
  const result = await q.query<IntegrationWebhookDeliveryRecord>(
    `SELECT ${A} FROM integration_webhook_deliveries
      WHERE ${LIST_WHERE}
      ORDER BY created_at DESC, id DESC`,
    params,
  );
  return result.rows;
}

async function countForClients(
  accessibleClientIds: readonly string[],
  filters: IntegrationWebhookDeliveryListFilters,
  q: Q = getPool(),
): Promise<number> {
  const result = await q.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM integration_webhook_deliveries
      WHERE ${LIST_WHERE}`,
    listParams(accessibleClientIds, filters),
  );
  return result.rows[0]?.n ?? 0;
}

export const integrationWebhookDeliveryRepository = {
  claimDelivery,
  countForClients,
  createOnConflictReturn,
  findByFanOutIdentity,
  findById,
  findDueDeliveries,
  listByOutboxEventId,
  listForClients,
  markDelivered,
  markExhausted,
  markFailedPermanent,
  markRetryScheduled,
  recoverStaleClaims,
};

import { getPool, withTransaction } from '../../database';
import { logger } from '../../shared/logger';
import { clampDueItemLimit } from '../../shared/due-retrieval';
import { integrationOutboxRepository } from '../integration-outbox';
import { integrationWebhookEndpointRepository } from '../integration-webhook-endpoints';
import { recordOperationalEvent } from '../operational-events';
import { integrationWebhookDeliveryRepository } from './integration-webhook-delivery.repository';
import {
  INTEGRATION_WEBHOOK_DELIVERY_AUDIT_ENTITY_TYPE,
  INTEGRATION_WEBHOOK_EVENT_TYPES,
  type IntegrationWebhookFanOutResult,
} from './integration-webhook-delivery.types';

/**
 * CR-BE-INTEG-01 PART 03 — outbox → delivery fan-out orchestration.
 *
 * Turns PENDING outbox rows into per-endpoint delivery ledger rows
 * (governance §7). Per outbox row, ONE transaction executes:
 *
 *   guarded claim (PENDING → PROCESSING)
 *     → resolve matching endpoints (all five §7 predicate rules in SQL:
 *       same Client, Building narrowing, subscribed type, ACTIVE,
 *       endpoint.created_at <= outbox.created_at)
 *     → idempotent delivery creation per endpoint (on-conflict-do-nothing)
 *     → markProcessed (PROCESSING → PROCESSED)
 *
 * SAFETY PROPERTIES
 * -----------------
 *   - PROCESSED and its deliveries commit ATOMICALLY: an outbox row can
 *     never be PROCESSED with a half-created delivery set ("mark processed
 *     only after fan-out completes safely"). Any throw rolls the row back to
 *     PENDING, where the next pass retries it (transient errors are
 *     self-healing; the outbox FAILED state stays reserved for governed
 *     poison handling).
 *   - Duplicate fan-out is impossible twice over: the outbox claim guard
 *     (exactly one worker wins PROCESSING) and the ledger's
 *     `UNIQUE (outbox_event_id, endpoint_id)` on-conflict creation.
 *   - Zero matching endpoints (e.g. deactivated between enqueue and
 *     fan-out) is a VALID outcome: the row becomes PROCESSED with no
 *     deliveries — never an error, never a retry loop.
 *   - Per-row error isolation: one poison row cannot stop the batch.
 *
 * NO HTTP contact, signing, retry engine, or scheduler concern lives here —
 * PART 04 executes deliveries; PART 05 wires the dispatcher.
 */

export type FanOutOptions = {
  /** Bounded batch size for one pass (clamped by the shared due limit). */
  limit?: number;
};

/** Enumerates one bounded batch of PENDING outbox row ids (oldest first). */
async function findPendingOutboxIds(limit: number): Promise<string[]> {
  const result = await getPool().query<{ id: string }>(
    `SELECT id FROM integration_outbox_events
      WHERE status = 'PENDING'
      ORDER BY created_at ASC, id ASC
      LIMIT $1`,
    [clampDueItemLimit(limit)],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Fans one claimed outbox row out inside the caller's transaction.
 * Returns the number of deliveries newly created.
 */
async function fanOutOne(
  outboxEventId: string,
): Promise<{ created: number; claimed: boolean }> {
  return withTransaction(async (tx) => {
    const claimed = await integrationOutboxRepository.claimPending(outboxEventId, tx);
    if (!claimed) {
      // A concurrent runner owns (or already finished) this row.
      return { created: 0, claimed: false };
    }

    const endpoints = await integrationWebhookEndpointRepository.findMatchingForFanOut(
      claimed.clientId,
      claimed.buildingId,
      claimed.eventType,
      new Date(claimed.createdAt),
      tx,
    );

    let created = 0;
    for (const endpoint of endpoints) {
      const result = await integrationWebhookDeliveryRepository.createOnConflictReturn(
        {
          outboxEventId: claimed.id,
          endpointId: endpoint.id,
          clientId: claimed.clientId,
          buildingId: claimed.buildingId,
          eventType: claimed.eventType,
        },
        tx,
      );
      if (result.created) {
        created += 1;
        // PART 05 (§9): QUEUED audit event, atomic with the fan-out
        // transaction. The INTEGRATION_ prefix keeps it recursion-blocked at
        // the outbox enqueue seam. Metadata carries identity + payload SIZE
        // only — never the payload body, never secret material.
        await recordOperationalEvent(
          {
            clientId: claimed.clientId,
            eventType: INTEGRATION_WEBHOOK_EVENT_TYPES.QUEUED,
            entityType: INTEGRATION_WEBHOOK_DELIVERY_AUDIT_ENTITY_TYPE,
            entityId: result.record.id,
            buildingId: claimed.buildingId,
            summary: `Integration webhook delivery queued (source ${claimed.eventType}).`,
            metadata: {
              endpointId: endpoint.id,
              outboxEventId: claimed.id,
              sourceEventType: claimed.eventType,
              payloadSizeBytes: Buffer.byteLength(claimed.payload, 'utf8'),
            },
          },
          tx,
        );
      }
    }

    const processed = await integrationOutboxRepository.markProcessed(claimed.id, tx);
    if (!processed) {
      // Unreachable while we hold the claim inside this transaction — fail
      // loudly (and roll everything back) rather than commit a half state.
      throw new Error(
        'Integration outbox fan-out: PROCESSING row could not be marked PROCESSED.',
      );
    }

    return { created, claimed: true };
  });
}

/**
 * One bounded fan-out pass over the PENDING outbox. Per-row isolation: a
 * throwing row is logged, counted, left PENDING, and retried next pass.
 */
export async function fanOutIntegrationOutboxEvents(
  options: FanOutOptions = {},
): Promise<IntegrationWebhookFanOutResult> {
  const ids = await findPendingOutboxIds(options.limit ?? Number.NaN);

  const result: IntegrationWebhookFanOutResult = {
    pending: ids.length,
    processed: 0,
    deliveriesCreated: 0,
    skipped: 0,
    failures: 0,
  };

  for (const id of ids) {
    try {
      const outcome = await fanOutOne(id);
      if (!outcome.claimed) {
        result.skipped += 1;
        continue;
      }
      result.processed += 1;
      result.deliveriesCreated += outcome.created;
    } catch (error) {
      result.failures += 1;
      logger.error(
        `Integration webhook fan-out failed unexpectedly for outbox event ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}

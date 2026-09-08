import { withTransaction } from '../../database';
import { logger } from '../../shared/logger';
import { integrationOutboxRepository } from '../integration-outbox';
import { integrationWebhookEndpointRepository } from '../integration-webhook-endpoints';
import { computeOutboundRetryDelayMs } from '../notification-delivery';
import { recordOperationalEvent } from '../operational-events';
import {
  createFetchIntegrationWebhookTransport,
  sanitizeIntegrationWebhookError,
  sendIntegrationWebhook,
  type IntegrationWebhookTransport,
} from './integration-webhook-http.adapter';
import {
  buildIntegrationWebhookRequestHeaders,
  buildIntegrationWebhookSignatureHeader,
} from './integration-webhook-signature';
import { integrationWebhookDeliveryRepository as ledger } from './integration-webhook-delivery.repository';
import {
  INTEGRATION_WEBHOOK_DELIVERY_AUDIT_ENTITY_TYPE,
  INTEGRATION_WEBHOOK_EVENT_TYPES,
  type IntegrationWebhookDeliveryRecord,
} from './integration-webhook-delivery.types';

/**
 * CR-BE-INTEG-01 PART 04 — webhook delivery execution + retry engine.
 *
 * Drains the PART 03 ledger through the governed chain:
 *
 *   stale-claim recovery → due enumeration (SKIP LOCKED, bounded)
 *     → guarded claim (PENDING/RETRY_SCHEDULED → SENDING)
 *     → sign (HMAC-SHA256 over timestamp.deliveryId.payloadBytes, §5)
 *     → HTTP POST with the endpoint's bounded timeout
 *     → guarded result transition per the §6.4 classification.
 *
 * CLASSIFICATION → TRANSITION
 * ---------------------------
 *   DELIVERED (2xx only)        → markDelivered (terminal),
 *   RETRYABLE (408/425/429/5xx/
 *              network/timeout) → retry window via the REUSED
 *                                 `computeOutboundRetryDelayMs` (5 min base,
 *                                 6 h cap, ±25% jitter) — or EXHAUSTED when
 *                                 this attempt spends the budget,
 *   PERMANENT (3xx/other 4xx)   → markFailedPermanent (terminal).
 *
 * IDEMPOTENCY / RETRY SAFETY
 * --------------------------
 * The guarded claim is the single owner of an attempt; every result seam is
 * status-guarded on SENDING; the payload bytes and the delivery id are
 * stable across attempts (only the timestamp/signature vary), so receivers
 * dedup on `X-Asentra-Delivery-Id`. A row whose endpoint vanished from the
 * sendable state (INACTIVE / unreadable secret) terminates FAILED_PERMANENT
 * — INACTIVE stops attempts at claim time (§3.3), never a retry loop.
 *
 * NO scheduler/dispatcher wiring and NO operational-event audit lives here —
 * PART 05 wires both. Errors persisted to the ledger are sanitized,
 * controlled-part strings; secrets are read through the signing-path seam
 * only and never logged.
 */

/** Bounded due-retrieval batch for one execution pass. */
export const INTEGRATION_WEBHOOK_DUE_RETRIEVAL_LIMIT = 100;

/** SENDING rows older than this are recovered as crashed claims (§4.2). */
export const INTEGRATION_WEBHOOK_STALE_CLAIM_MS = 15 * 60_000;

/** Aggregate result of one execution pass (PART 05 dispatcher consumer). */
export type DueIntegrationWebhookDeliveryResult = {
  due: number;
  delivered: number;
  retryScheduled: number;
  failedPermanent: number;
  exhausted: number;
  /** Claims lost to a concurrent runner (stay due — neither work nor error). */
  skipped: number;
  /** Unexpected throws, isolated per row. */
  failures: number;
  /** Stale SENDING claims recovered before enumeration. */
  staleRecovered: number;
};

export type ExecuteDueWebhookDeliveryOptions = {
  limit?: number;
  /** Injectable transport (tests). Defaults to the registered transport. */
  transport?: IntegrationWebhookTransport;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable RNG for deterministic backoff in tests. */
  random?: () => number;
};

/**
 * CR-BE-INTEG-01 PART 05 — registrable default transport.
 *
 * The production default is the bounded fetch transport; tests (and only
 * tests) register a mock so dispatcher-level runs never touch the network —
 * the same registration precedent as the PART 01 subscription probe.
 */
let activeDefaultTransport: IntegrationWebhookTransport | null = null;

export function registerIntegrationWebhookTransport(
  transport: IntegrationWebhookTransport,
): void {
  activeDefaultTransport = transport;
}

export function resetIntegrationWebhookTransport(): void {
  activeDefaultTransport = null;
}

function resolveTransport(
  override?: IntegrationWebhookTransport,
): IntegrationWebhookTransport {
  return override ?? activeDefaultTransport ?? createFetchIntegrationWebhookTransport();
}

/**
 * PART 05 (§9) — one governed audit event per result transition, recorded
 * from the POST-transition ledger row. All types are recursion-blocked at
 * the outbox enqueue seam. Metadata carries identity, attempt accounting,
 * the HTTP status, and the already-sanitized error — never payload bodies,
 * secrets, or Authorization material.
 */
async function recordDeliveryAuditEvent(
  eventType: string,
  record: IntegrationWebhookDeliveryRecord,
): Promise<void> {
  await recordOperationalEvent({
    clientId: record.clientId,
    eventType,
    entityType: INTEGRATION_WEBHOOK_DELIVERY_AUDIT_ENTITY_TYPE,
    entityId: record.id,
    buildingId: record.buildingId,
    summary: `Integration webhook delivery ${eventType
      .replace('INTEGRATION_WEBHOOK_', '')
      .toLowerCase()} (attempt ${record.attemptCount} of ${record.maxAttempts}).`,
    metadata: {
      endpointId: record.endpointId,
      outboxEventId: record.outboxEventId,
      sourceEventType: record.eventType,
      attempt: record.attemptCount,
      maxAttempts: record.maxAttempts,
      responseStatus: record.lastResponseStatus,
      error: record.lastError,
      nextRetryAt: record.nextRetryAt ? new Date(record.nextRetryAt).toISOString() : null,
    },
  });
}

/** Terminal-failure helper for rows that can never be sent. */
async function failUnsendable(
  delivery: IntegrationWebhookDeliveryRecord,
  attemptedAt: Date,
  reason: string,
): Promise<'failedPermanent'> {
  const record = await ledger.markFailedPermanent(delivery.id, {
    attemptedAt,
    responseStatus: null,
    error: sanitizeIntegrationWebhookError(reason),
  });
  if (record) {
    await recordDeliveryAuditEvent(
      INTEGRATION_WEBHOOK_EVENT_TYPES.FAILED_PERMANENT,
      record,
    );
  }
  return 'failedPermanent';
}

/**
 * Executes ONE claimed delivery (the caller owns the SENDING claim) and
 * applies exactly one guarded result transition.
 */
async function executeClaimedDelivery(
  claimed: IntegrationWebhookDeliveryRecord,
  transport: IntegrationWebhookTransport,
  now: () => Date,
  random?: () => number,
): Promise<'delivered' | 'retryScheduled' | 'failedPermanent' | 'exhausted'> {
  const attemptedAt = now();
  const attemptNumber = claimed.attemptCount + 1;

  // Sendable-state gate: endpoint must exist, be ACTIVE, and have a secret.
  const endpoint = await integrationWebhookEndpointRepository.findById(claimed.endpointId);
  if (!endpoint || endpoint.status !== 'ACTIVE') {
    return failUnsendable(claimed, attemptedAt, 'Endpoint is inactive or missing.');
  }
  const outboxEvent = await integrationOutboxRepository.findById(claimed.outboxEventId);
  if (!outboxEvent) {
    return failUnsendable(claimed, attemptedAt, 'Outbox event snapshot is missing.');
  }
  const secret = await integrationWebhookEndpointRepository.findSigningSecretById(
    endpoint.id,
  );
  if (!secret) {
    return failUnsendable(claimed, attemptedAt, 'Signing secret is unreadable.');
  }

  // Sign the EXACT stored payload bytes (§5) — never re-serialized.
  const timestamp = Math.floor(attemptedAt.getTime() / 1000);
  const signatureHeader = buildIntegrationWebhookSignatureHeader({
    secret,
    timestamp,
    deliveryId: claimed.id,
    payload: outboxEvent.payload,
  });
  const headers = buildIntegrationWebhookRequestHeaders({
    timestamp,
    deliveryId: claimed.id,
    eventId: outboxEvent.operationalEventId,
    eventType: outboxEvent.eventType,
    signatureHeader,
  });

  const result = await sendIntegrationWebhook(
    {
      url: endpoint.url,
      headers,
      body: outboxEvent.payload,
      timeoutMs: endpoint.timeoutMs,
    },
    transport,
  );

  if (result.outcome === 'DELIVERED') {
    const record = await ledger.markDelivered(claimed.id, {
      attemptedAt,
      responseStatus: result.responseStatus,
    });
    if (record) {
      await recordDeliveryAuditEvent(INTEGRATION_WEBHOOK_EVENT_TYPES.DELIVERED, record);
    }
    return 'delivered';
  }

  if (result.outcome === 'PERMANENT') {
    const record = await ledger.markFailedPermanent(claimed.id, {
      attemptedAt,
      responseStatus: result.responseStatus,
      error: result.error,
    });
    if (record) {
      await recordDeliveryAuditEvent(
        INTEGRATION_WEBHOOK_EVENT_TYPES.FAILED_PERMANENT,
        record,
      );
    }
    return 'failedPermanent';
  }

  // RETRYABLE: bounded budget + reused exponential backoff with jitter.
  if (attemptNumber >= claimed.maxAttempts) {
    const record = await ledger.markExhausted(claimed.id, {
      attemptedAt,
      responseStatus: result.responseStatus,
      error: result.error,
    });
    if (record) {
      await recordDeliveryAuditEvent(INTEGRATION_WEBHOOK_EVENT_TYPES.EXHAUSTED, record);
    }
    return 'exhausted';
  }
  const delayMs = computeOutboundRetryDelayMs(attemptNumber, { random });
  const record = await ledger.markRetryScheduled(claimed.id, {
    attemptedAt,
    nextRetryAt: new Date(attemptedAt.getTime() + delayMs),
    responseStatus: result.responseStatus,
    error: result.error,
  });
  if (record) {
    await recordDeliveryAuditEvent(
      INTEGRATION_WEBHOOK_EVENT_TYPES.RETRY_SCHEDULED,
      record,
    );
  }
  return 'retryScheduled';
}

/**
 * One bounded execution pass over the due delivery ledger. Per-row error
 * isolation: an unexpected throw is logged, counted, and never stops the
 * pass; the row is recovered by the stale-claim seam on a later pass.
 */
export async function executeDueIntegrationWebhookDeliveries(
  before: Date = new Date(),
  options: ExecuteDueWebhookDeliveryOptions = {},
): Promise<DueIntegrationWebhookDeliveryResult> {
  const transport = resolveTransport(options.transport);
  const now = options.now ?? (() => new Date());

  const stale = await ledger.recoverStaleClaims(
    new Date(now().getTime() - INTEGRATION_WEBHOOK_STALE_CLAIM_MS),
  );

  const due = await withTransaction((tx) =>
    ledger.findDueDeliveries(
      before,
      options.limit ?? INTEGRATION_WEBHOOK_DUE_RETRIEVAL_LIMIT,
      tx,
    ),
  );

  const result: DueIntegrationWebhookDeliveryResult = {
    due: due.length,
    delivered: 0,
    retryScheduled: 0,
    failedPermanent: 0,
    exhausted: 0,
    skipped: 0,
    failures: 0,
    staleRecovered: stale.retryScheduled + stale.exhausted,
  };

  for (const delivery of due) {
    try {
      const claimed = await ledger.claimDelivery(delivery.id, now());
      if (!claimed) {
        result.skipped += 1;
        continue;
      }
      const outcome = await executeClaimedDelivery(
        claimed,
        transport,
        now,
        options.random,
      );
      result[outcome] += 1;
    } catch (error) {
      result.failures += 1;
      logger.error(
        `Integration webhook delivery execution failed unexpectedly for ${delivery.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return result;
}

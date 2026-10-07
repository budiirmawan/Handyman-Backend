import { readIntegrationOutboxConfig } from '../integration-outbox';
import {
  executeDueIntegrationWebhookDeliveries,
  type ExecuteDueWebhookDeliveryOptions,
} from './integration-webhook-execution.service';
import { fanOutIntegrationOutboxEvents } from './integration-webhook-fanout.service';

/**
 * CR-BE-INTEG-01 PART 05 — the dispatcher-facing webhook domain (governance
 * §8): ONE additive domain executing two bounded phases per tick, in order:
 *
 *   1. outbox fan-out (§7)   — PENDING outbox rows → per-endpoint deliveries,
 *   2. delivery execution (§6) — due deliveries → sign → POST → transition,
 *
 * so an event enqueued before a tick is fanned out AND attempted in the SAME
 * tick. Reuses the existing due-job dispatcher only — no new scheduler,
 * timer, cron, queue, or worker process anywhere.
 *
 * DARK BY DEFAULT: with `INTEGRATION_WEBHOOKS_ENABLED` off the whole domain
 * is a cheap no-op (no query runs). The flag governs the entire feature:
 * turning it off also pauses execution of any deliveries left over from an
 * enabled period — nothing is lost, the ledger simply stays due.
 *
 * The result shape is EXACTLY the seven governance §8 counters — additive on
 * `DueJobDispatchResult`, never changing an existing key's meaning.
 */

/** The governance §8 dispatcher result contract for this domain. */
export type DueIntegrationWebhookJobResult = {
  /** Delivery rows newly created by this tick's fan-out phase. */
  fannedOut: number;
  delivered: number;
  retryScheduled: number;
  failedPermanent: number;
  exhausted: number;
  /** Claims lost to concurrent runners across both phases (stay due). */
  skipped: number;
  /** Per-row isolated unexpected throws across both phases. */
  failures: number;
};

const IDLE_RESULT: DueIntegrationWebhookJobResult = {
  fannedOut: 0,
  delivered: 0,
  retryScheduled: 0,
  failedPermanent: 0,
  exhausted: 0,
  skipped: 0,
  failures: 0,
};

/**
 * One dispatcher tick of the integration webhook domain: fan-out, then due
 * delivery execution. Safe on an empty window; per-row failures are already
 * isolated inside each phase.
 */
export async function processDueIntegrationWebhookJobs(
  before: Date = new Date(),
  options: ExecuteDueWebhookDeliveryOptions = {},
): Promise<DueIntegrationWebhookJobResult> {
  if (!readIntegrationOutboxConfig().enabled) {
    return { ...IDLE_RESULT };
  }

  const fanOut = await fanOutIntegrationOutboxEvents({ limit: options.limit });
  const execution = await executeDueIntegrationWebhookDeliveries(before, options);

  return {
    fannedOut: fanOut.deliveriesCreated,
    delivered: execution.delivered,
    retryScheduled: execution.retryScheduled,
    failedPermanent: execution.failedPermanent,
    exhausted: execution.exhausted,
    skipped: fanOut.skipped + execution.skipped,
    failures: fanOut.failures + execution.failures,
  };
}

import { registerIntegrationOutboxSubscriptionProbe } from '../integration-outbox';
import { integrationWebhookEndpointRepository } from './integration-webhook-endpoint.repository';

/**
 * CR-BE-INTEG-01 PART 02 — real outbox subscription probe.
 *
 * Replaces the PART 01 conservative default (always false) with the
 * governance §2.3 stage-3 gate: a single indexed `SELECT EXISTS` on the
 * caller's executor asking whether at least one ACTIVE endpoint of the
 * event's Client subscribes to the event type. Combined with the flag and
 * the recursion blocklist, this is what keeps rollout prospective-only —
 * outbox rows exist only for events recorded WHILE a matching ACTIVE
 * endpoint already exists.
 */
export function registerIntegrationWebhookSubscriptionProbe(): void {
  registerIntegrationOutboxSubscriptionProbe(async (event, executor) =>
    integrationWebhookEndpointRepository.hasActiveSubscription(
      event.clientId,
      event.eventType,
      executor,
    ),
  );
}

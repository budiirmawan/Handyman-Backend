/**
 * CR-BE-INTEG-01 PART 01 — Transactional outbox foundation (public seams).
 *
 * `operational_events` (BE-07) remains the ONLY business-event authority;
 * this module adds the thin `integration_outbox_events` marker, the canonical
 * byte-stable payload envelope, and the gated prospective enqueue seam wired
 * through `recordOperationalEvent`. No webhook endpoint, secret, delivery
 * ledger, HTTP/HMAC sending, retry engine, or scheduler concern lives here
 * (PART 02+).
 */

export { readIntegrationOutboxConfig } from './integration-outbox.config';
export {
  maybeEnqueueIntegrationOutboxEvent,
  registerIntegrationOutboxSubscriptionProbe,
  resetIntegrationOutboxSubscriptionProbe,
} from './integration-outbox.enqueue';
export type { IntegrationOutboxSubscriptionProbe } from './integration-outbox.enqueue';
export {
  buildIntegrationOutboxPayload,
  serializeIntegrationOutboxPayload,
} from './integration-outbox.payload';
export type { IntegrationOutboxPayload } from './integration-outbox.payload';
export { integrationOutboxRepository } from './integration-outbox.repository';
export {
  INTEGRATION_OUTBOX_BLOCKED_EVENT_TYPE_PREFIXES,
  INTEGRATION_OUTBOX_STATUSES,
  isIntegrationOutboxBlockedEventType,
  isIntegrationOutboxStatus,
} from './integration-outbox.types';
export type {
  IntegrationOutboxCreateResult,
  IntegrationOutboxEventRecord,
  IntegrationOutboxStatus,
  NewIntegrationOutboxEvent,
} from './integration-outbox.types';

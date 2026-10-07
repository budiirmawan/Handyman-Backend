/**
 * CR-BE-INTEG-01 PART 03 — Event fan-out + delivery ledger (public seams).
 *
 * One durable, claimable delivery ledger row per (outbox event, matching
 * ACTIVE endpoint), plus the fan-out orchestration that produces them and
 * atomically marks the outbox row PROCESSED. Payload bytes remain on the
 * outbox row (byte-stable). No HTTP sending, HMAC signing, retry engine, or
 * scheduler concern lives here (PART 04+).
 */

export {
  fanOutIntegrationOutboxEvents,
} from './integration-webhook-fanout.service';
export type { FanOutOptions } from './integration-webhook-fanout.service';
export {
  INTEGRATION_WEBHOOK_DUE_RETRIEVAL_LIMIT,
  INTEGRATION_WEBHOOK_STALE_CLAIM_MS,
  executeDueIntegrationWebhookDeliveries,
  registerIntegrationWebhookTransport,
  resetIntegrationWebhookTransport,
} from './integration-webhook-execution.service';
export type {
  DueIntegrationWebhookDeliveryResult,
  ExecuteDueWebhookDeliveryOptions,
} from './integration-webhook-execution.service';
export {
  processDueIntegrationWebhookJobs,
} from './integration-webhook-dispatch.service';
export type { DueIntegrationWebhookJobResult } from './integration-webhook-dispatch.service';
export {
  getIntegrationWebhookDeliveryById,
  listIntegrationWebhookDeliveries,
  toPublicIntegrationWebhookDelivery,
} from './integration-webhook-delivery.read.service';
export { createIntegrationWebhookDeliveryRouter } from './integration-webhook-delivery.routes';
export {
  INTEGRATION_WEBHOOK_SEND_OUTCOMES,
  classifyIntegrationWebhookResponseStatus,
  createFetchIntegrationWebhookTransport,
  sanitizeIntegrationWebhookError,
  sendIntegrationWebhook,
} from './integration-webhook-http.adapter';
export type {
  IntegrationWebhookHttpRequest,
  IntegrationWebhookHttpResponse,
  IntegrationWebhookSendOutcome,
  IntegrationWebhookSendResult,
  IntegrationWebhookTransport,
} from './integration-webhook-http.adapter';
export {
  INTEGRATION_WEBHOOK_HEADERS,
  INTEGRATION_WEBHOOK_SIGNATURE_VERSION,
  INTEGRATION_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS,
  INTEGRATION_WEBHOOK_USER_AGENT,
  buildIntegrationWebhookRequestHeaders,
  buildIntegrationWebhookSignatureHeader,
  buildIntegrationWebhookSignedPayload,
  computeIntegrationWebhookSignature,
  verifyIntegrationWebhookSignature,
} from './integration-webhook-signature';
export type {
  IntegrationWebhookHeaderInput,
  IntegrationWebhookSignatureInput,
} from './integration-webhook-signature';
export { integrationWebhookDeliveryRepository } from './integration-webhook-delivery.repository';
export {
  INTEGRATION_WEBHOOK_DELIVERY_AUDIT_ENTITY_TYPE,
  INTEGRATION_WEBHOOK_DELIVERY_CLAIMABLE_STATUSES,
  INTEGRATION_WEBHOOK_DELIVERY_DEFAULT_MAX_ATTEMPTS,
  INTEGRATION_WEBHOOK_DELIVERY_STATUSES,
  INTEGRATION_WEBHOOK_DELIVERY_TERMINAL_STATUSES,
  INTEGRATION_WEBHOOK_EVENT_TYPES,
  isIntegrationWebhookDeliveryStatus,
} from './integration-webhook-delivery.types';
export type {
  IntegrationWebhookDeliveryAttemptOutcome,
  IntegrationWebhookDeliveryCreateResult,
  IntegrationWebhookDeliveryListFilters,
  IntegrationWebhookDeliveryRecord,
  IntegrationWebhookDeliveryRetryOutcome,
  IntegrationWebhookDeliveryStatus,
  IntegrationWebhookFanOutResult,
  NewIntegrationWebhookDelivery,
  PublicIntegrationWebhookDelivery,
} from './integration-webhook-delivery.types';

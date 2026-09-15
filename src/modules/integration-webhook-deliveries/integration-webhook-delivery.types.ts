/**
 * CR-BE-INTEG-01 PART 03 — webhook delivery ledger types.
 *
 * One ledger row per (outbox event, endpoint) is the claimable lifecycle
 * authority for one webhook delivery (governance §4). The payload bytes stay
 * on the referenced outbox row (byte-stable TEXT, §2.1) — the ledger carries
 * identity snapshot + lifecycle + attempt accounting only. The delivery `id`
 * is also the receiver-facing idempotency key (stable across attempts, §5).
 */

export const INTEGRATION_WEBHOOK_DELIVERY_STATUSES = [
  'PENDING',
  'SENDING',
  'DELIVERED',
  'RETRY_SCHEDULED',
  'FAILED_PERMANENT',
  'EXHAUSTED',
] as const;
export type IntegrationWebhookDeliveryStatus =
  (typeof INTEGRATION_WEBHOOK_DELIVERY_STATUSES)[number];

export function isIntegrationWebhookDeliveryStatus(
  value: unknown,
): value is IntegrationWebhookDeliveryStatus {
  return (
    typeof value === 'string' &&
    (INTEGRATION_WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/** Lifecycle states from which a claim may start (the guarded claim set). */
export const INTEGRATION_WEBHOOK_DELIVERY_CLAIMABLE_STATUSES: readonly IntegrationWebhookDeliveryStatus[] =
  ['PENDING', 'RETRY_SCHEDULED'];

/** Lifecycle states that can never be claimed or re-executed. */
export const INTEGRATION_WEBHOOK_DELIVERY_TERMINAL_STATUSES: readonly IntegrationWebhookDeliveryStatus[] =
  ['DELIVERED', 'FAILED_PERMANENT', 'EXHAUSTED'];

/** Default bounded attempt budget (governance §6.2; the column default). */
export const INTEGRATION_WEBHOOK_DELIVERY_DEFAULT_MAX_ATTEMPTS = 5;

/**
 * CR-BE-INTEG-01 PART 05 — governed audit vocabulary (governance §9).
 *
 * Every type carries the `INTEGRATION_` prefix and is therefore on the
 * PART 01 recursion blocklist: an integration-delivery audit event can never
 * enqueue outbox fan-out of itself.
 */
export const INTEGRATION_WEBHOOK_EVENT_TYPES = {
  QUEUED: 'INTEGRATION_WEBHOOK_QUEUED',
  DELIVERED: 'INTEGRATION_WEBHOOK_DELIVERED',
  RETRY_SCHEDULED: 'INTEGRATION_WEBHOOK_RETRY_SCHEDULED',
  FAILED_PERMANENT: 'INTEGRATION_WEBHOOK_FAILED_PERMANENT',
  EXHAUSTED: 'INTEGRATION_WEBHOOK_EXHAUSTED',
} as const;

/** The BE-07 entity type carried by all webhook-delivery audit events. */
export const INTEGRATION_WEBHOOK_DELIVERY_AUDIT_ENTITY_TYPE =
  'INTEGRATION_WEBHOOK_DELIVERY';

/** The raw persisted shape of one delivery ledger row. */
export type IntegrationWebhookDeliveryRecord = {
  id: string;
  outboxEventId: string;
  endpointId: string;
  clientId: string;
  buildingId: string | null;
  eventType: string;
  status: IntegrationWebhookDeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  /** Due window for RETRY_SCHEDULED; NULL = immediately due while claimable. */
  nextRetryAt: Date | null;
  lastAttemptAt: Date | null;
  /** HTTP status of the latest attempt (NULL for network/timeout failures). */
  lastResponseStatus: number | null;
  /** Sanitized, truncated failure description — never a response body dump. */
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Creation input for one fan-out delivery (the fan-out service is the caller). */
export type NewIntegrationWebhookDelivery = {
  outboxEventId: string;
  endpointId: string;
  clientId: string;
  buildingId: string | null;
  eventType: string;
  maxAttempts?: number;
};

/** Result of the idempotent creation seam. */
export type IntegrationWebhookDeliveryCreateResult = {
  record: IntegrationWebhookDeliveryRecord;
  /** false = a delivery for this (outbox event, endpoint) already existed. */
  created: boolean;
};

/**
 * CR-BE-INTEG-01 PART 06 — read-API filters (always intersected with the
 * caller's accessible-Client scope; never a scope bypass).
 */
export type IntegrationWebhookDeliveryListFilters = {
  clientId?: string;
  endpointId?: string;
  status?: IntegrationWebhookDeliveryStatus;
  eventType?: string;
  from?: Date;
  to?: Date;
};

/**
 * CR-BE-INTEG-01 PART 06 — the API projection of one delivery ledger row:
 * state / attempt / timing / response metadata ONLY. Deliberately absent
 * forever: signing secrets (never on this table) and payload bodies (they
 * live on the outbox row and are not an API concern).
 */
export type PublicIntegrationWebhookDelivery = {
  id: string;
  outboxEventId: string;
  endpointId: string;
  clientId: string;
  buildingId: string | null;
  eventType: string;
  status: IntegrationWebhookDeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  lastAttemptAt: string | null;
  lastResponseStatus: number | null;
  lastError: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Attempt outcome fields shared by the guarded result seams (PART 04 caller). */
export type IntegrationWebhookDeliveryAttemptOutcome = {
  attemptedAt: Date;
  responseStatus?: number | null;
  error?: string | null;
};

/** Retry outcome: the failed attempt plus the durable next due window. */
export type IntegrationWebhookDeliveryRetryOutcome =
  IntegrationWebhookDeliveryAttemptOutcome & {
    nextRetryAt: Date;
  };

/** Aggregate result of one fan-out pass (governance §7 / §8). */
export type IntegrationWebhookFanOutResult = {
  /** PENDING outbox rows enumerated by this pass. */
  pending: number;
  /** Outbox rows fanned out and marked PROCESSED by this pass. */
  processed: number;
  /** Delivery rows newly created by this pass. */
  deliveriesCreated: number;
  /** Rows whose claim was lost to a concurrent runner (stay due — no error). */
  skipped: number;
  /** Rows that threw (isolated per row; the row stays PENDING and retries). */
  failures: number;
};

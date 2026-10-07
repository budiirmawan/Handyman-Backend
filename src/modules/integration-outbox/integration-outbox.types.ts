/**
 * CR-BE-INTEG-01 PART 01 — integration outbox types.
 *
 * The outbox row is a thin "pending integration fan-out" marker over the
 * authoritative BE-07 `operational_events` row (governance §2). It carries a
 * unique reference to the event, an identity snapshot for fan-out matching,
 * and the byte-stable serialized payload envelope. It is NOT a second
 * business-event authority and it is never written outside the
 * `recordOperationalEvent` enqueue seam (no historical replay/backfill).
 */

export const INTEGRATION_OUTBOX_STATUSES = [
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
] as const;
export type IntegrationOutboxStatus = (typeof INTEGRATION_OUTBOX_STATUSES)[number];

export function isIntegrationOutboxStatus(
  value: unknown,
): value is IntegrationOutboxStatus {
  return (
    typeof value === 'string' &&
    (INTEGRATION_OUTBOX_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Recursion blocklist (governance §2.3 / §7.4): event types produced BY the
 * integration/notification delivery machinery itself can never enqueue an
 * outbox row, so integration-delivery audit events can never fan out into
 * further webhook deliveries. Matched case-insensitively by prefix, as a
 * code-level constant (never configuration).
 */
export const INTEGRATION_OUTBOX_BLOCKED_EVENT_TYPE_PREFIXES = [
  'INTEGRATION_',
  'NOTIFICATION_OUTBOUND_',
] as const;

/** Whether an event type is recursion-blocked from outbox enqueue. */
export function isIntegrationOutboxBlockedEventType(eventType: string): boolean {
  const normalized = eventType.trim().toUpperCase();
  return INTEGRATION_OUTBOX_BLOCKED_EVENT_TYPE_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix),
  );
}

/** The raw persisted shape of one outbox row. */
export type IntegrationOutboxEventRecord = {
  id: string;
  /** Unique reference to the authoritative `operational_events` row. */
  operationalEventId: string;
  clientId: string;
  buildingId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  /** Canonical envelope serialized once at enqueue time (byte-stable TEXT). */
  payload: string;
  occurredAt: Date;
  status: IntegrationOutboxStatus;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Creation input for one outbox row (the enqueue seam is the only caller). */
export type NewIntegrationOutboxEvent = {
  operationalEventId: string;
  clientId: string;
  buildingId: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: string;
  occurredAt: Date;
};

/** Result of the idempotent creation seam. */
export type IntegrationOutboxCreateResult = {
  record: IntegrationOutboxEventRecord;
  /** false = an outbox row for this operational event already existed. */
  created: boolean;
};

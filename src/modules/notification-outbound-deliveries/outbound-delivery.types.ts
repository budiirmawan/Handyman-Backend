/**
 * CR-BE-NOTIFY-PROV-01 PART 02 — outbound delivery ledger types.
 *
 * The ledger row is the claimable lifecycle authority for one outbound
 * delivery intent (governance §3.4): one row per (channel, recipient,
 * intent), snapshotting the rendered content once at intent time and carrying
 * the lifecycle (`PENDING → SENDING → SENT / RETRY_SCHEDULED /
 * FAILED_PERMANENT / EXHAUSTED`), the attempt accounting, and the provider
 * result fields across attempts. The existing BE-26F/G attempt tables remain
 * the immutable per-attempt history (linked via `delivery_id`, migration
 * 0299). No orchestration, retry engine, or provider contact lives here.
 */

/**
 * CR-BE-PUSH-01 PART 03A — the ledger channel vocabulary, widened with PUSH
 * (governance §10.2). PUSH is an ordinary outbound channel on the SAME
 * ledger: it reuses the existing lifecycle, the existing attempt accounting,
 * the existing retry budget and the existing idempotency key. EMAIL and
 * WHATSAPP semantics are untouched.
 *
 * A PUSH row addresses a RECIPIENT (`recipient_address = 'user:<userId>'`),
 * never a device and never a token — one user owns N devices, so device
 * selection is a SEND-time concern, not a ledger identity (§10.2).
 */
export const OUTBOUND_DELIVERY_CHANNELS = ['EMAIL', 'WHATSAPP', 'PUSH'] as const;
export type OutboundDeliveryChannel = (typeof OUTBOUND_DELIVERY_CHANNELS)[number];

export function isOutboundDeliveryChannel(value: unknown): value is OutboundDeliveryChannel {
  return (
    typeof value === 'string' &&
    (OUTBOUND_DELIVERY_CHANNELS as readonly string[]).includes(value)
  );
}

export const OUTBOUND_DELIVERY_STATUSES = [
  'PENDING',
  'SENDING',
  'SENT',
  'RETRY_SCHEDULED',
  'FAILED_PERMANENT',
  'EXHAUSTED',
] as const;
export type OutboundDeliveryStatus = (typeof OUTBOUND_DELIVERY_STATUSES)[number];

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — provider feedback vocabulary (governance
 * §6). Feedback is post-acceptance: it annotates a SENT delivery and never
 * reopens the send/retry lifecycle. WhatsApp uses DELIVERED /
 * PROVIDER_FAILED; BOUNCED / COMPLAINT are reserved for a future email
 * feedback path.
 */
export const OUTBOUND_DELIVERY_FEEDBACK_STATUSES = [
  'DELIVERED',
  'BOUNCED',
  'COMPLAINT',
  'PROVIDER_FAILED',
] as const;
export type OutboundDeliveryFeedbackStatus =
  (typeof OUTBOUND_DELIVERY_FEEDBACK_STATUSES)[number];

export function isOutboundDeliveryFeedbackStatus(
  value: unknown,
): value is OutboundDeliveryFeedbackStatus {
  return (
    typeof value === 'string' &&
    (OUTBOUND_DELIVERY_FEEDBACK_STATUSES as readonly string[]).includes(value)
  );
}

export function isOutboundDeliveryStatus(value: unknown): value is OutboundDeliveryStatus {
  return (
    typeof value === 'string' &&
    (OUTBOUND_DELIVERY_STATUSES as readonly string[]).includes(value)
  );
}

/** Lifecycle states from which a claim may start (the guarded claim set). */
export const OUTBOUND_DELIVERY_CLAIMABLE_STATUSES: readonly OutboundDeliveryStatus[] = [
  'PENDING',
  'RETRY_SCHEDULED',
];

/** Lifecycle states that can never be claimed or re-executed. */
export const OUTBOUND_DELIVERY_TERMINAL_STATUSES: readonly OutboundDeliveryStatus[] = [
  'SENT',
  'FAILED_PERMANENT',
  'EXHAUSTED',
];

/** The raw persisted shape of one ledger row. */
export type OutboundDeliveryRecord = {
  id: string;
  clientId: string;
  buildingId: string | null;
  recipientUserId: string;
  channel: OutboundDeliveryChannel;
  templateKey: string | null;
  sourceEventType: string;
  sourceEntityType: string;
  sourceEntityId: string;
  /** Rendered-once content snapshot (null subject for WhatsApp). */
  subject: string | null;
  message: string;
  /** Resolved contact snapshot (email address or E.164-ish phone). */
  recipientAddress: string;
  status: OutboundDeliveryStatus;
  attemptCount: number;
  maxAttempts: number;
  /** Due window for RETRY_SCHEDULED; NULL = immediately due while claimable. */
  nextRetryAt: Date | null;
  lastAttemptAt: Date | null;
  /** Provider discriminator of the latest attempt (set by the result seams). */
  provider: string | null;
  providerMessageId: string | null;
  lastError: string | null;
  /**
   * CR-BE-NOTIFY-PROV-01 PART 07 — post-acceptance provider feedback
   * (callback seam). NULL until the first accepted feedback; the send-path
   * `status` is never changed by feedback.
   */
  providerFeedbackStatus: OutboundDeliveryFeedbackStatus | null;
  feedbackAt: Date | null;
  feedbackError: string | null;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
};

/** Creation input for one ledger row (PART 03 orchestration is the caller). */
export type NewOutboundDelivery = {
  clientId: string;
  buildingId?: string | null;
  recipientUserId: string;
  channel: OutboundDeliveryChannel;
  templateKey?: string | null;
  sourceEventType: string;
  sourceEntityType: string;
  sourceEntityId: string;
  subject?: string | null;
  message: string;
  recipientAddress: string;
  /** Delivery-level idempotency key from the idempotency authority. */
  idempotencyKey: string;
  /** Optional override; defaults to the ledger column default. */
  maxAttempts?: number;
};

/**
 * Outcome fields recorded by the guarded result seams after an adapter call.
 * `provider` / `providerMessageId` are preserved from the first attempt when
 * a later attempt does not supply them.
 */
export type OutboundDeliveryAttemptOutcome = {
  attemptedAt: Date;
  provider?: string | null;
  providerMessageId?: string | null;
  /** Sanitized failure message (credential redaction is the caller's duty). */
  error?: string | null;
};

/** Additional due-window input for scheduling the next attempt. */
export type OutboundDeliveryRetryOutcome = OutboundDeliveryAttemptOutcome & {
  nextRetryAt: Date;
};

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — guarded feedback input. `feedbackError`
 * must already be sanitized (credential redaction is the caller's duty).
 */
export type OutboundDeliveryFeedbackInput = {
  feedbackStatus: OutboundDeliveryFeedbackStatus;
  feedbackAt: Date;
  feedbackError?: string | null;
};

/** Result of the idempotent creation seam. */
export type OutboundDeliveryCreateResult = {
  record: OutboundDeliveryRecord;
  /** `true` when this call inserted the row; `false` on idempotency-key hit. */
  created: boolean;
};

import { getPool } from '../../database';
import {
  notificationOutboundDeliveryRepository as ledgerRepository,
  type OutboundDeliveryFeedbackStatus,
  type OutboundDeliveryRecord,
} from '../notification-outbound-deliveries';
import { recordOperationalEvent } from '../operational-events';
import type {
  MetaWhatsAppStatusUpdate,
  MetaWhatsAppWebhookPayload,
  WhatsAppCallbackProcessingResult,
} from './whatsapp-callback.types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 07 — Meta WhatsApp delivery feedback processing.
 *
 * Maps verified Meta status callbacks onto the PART 02 outbound ledger:
 *
 *   Meta status      → ledger feedback
 *   ----------------   ----------------------------------------
 *   sent             → no-op (SENT already records acceptance)
 *   delivered / read → DELIVERED
 *   failed           → PROVIDER_FAILED (+ sanitized provider error)
 *   anything else    → no-op
 *
 * CORRELATION (gate finding): primary key is the provider message id
 * (`statuses[].id` = wamid → ledger `provider_message_id`, PART 07 index);
 * fallback is the immutable attempt history (`provider_reference` →
 * `delivery_id`, the PART 02 linkage).
 *
 * IDEMPOTENCY / ORDERING: the guarded transition (`status='SENT'` AND
 * `provider_feedback_status IS NULL`) makes every callback replay-safe:
 * duplicates and out-of-order statuses are deterministic no-ops. Feedback
 * NEVER reopens the send lifecycle — the send-path status and the immutable
 * attempt tables are untouched; only the ledger's feedback annotation and an
 * operational event are written.
 */

export const WHATSAPP_CALLBACK_EVENT_TYPES = {
  DELIVERED: 'NOTIFICATION_OUTBOUND_DELIVERED',
  PROVIDER_FAILED: 'NOTIFICATION_OUTBOUND_PROVIDER_FAILED',
} as const;

const MAX_FEEDBACK_ERROR_LENGTH = 500;
const SECRET_PATTERN =
  /(password|passwd|pwd|secret|api[_-]?key|token|authorization|bearer|auth[_-]?token)\s*[:=]\s*[^\s,;"']+/gi;

/** Redacts credential-like fragments from provider error text. */
export function sanitizeWhatsAppFeedbackError(message: string): string {
  const redacted = message.replace(SECRET_PATTERN, '$1=[REDACTED]');
  return redacted.length > MAX_FEEDBACK_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_FEEDBACK_ERROR_LENGTH)}…`
    : redacted;
}

/** Maps a Meta status string to a ledger feedback state (null = no-op). */
export function mapMetaStatusToFeedback(
  status: unknown,
): OutboundDeliveryFeedbackStatus | null {
  if (status === 'delivered' || status === 'read') {
    return 'DELIVERED';
  }
  if (status === 'failed') {
    return 'PROVIDER_FAILED';
  }
  return null;
}

/** Correlates a wamid to a ledger row (primary index, attempt fallback). */
async function correlateDelivery(
  providerMessageId: string,
): Promise<OutboundDeliveryRecord | null> {
  const direct = await ledgerRepository.findByProviderMessageId(providerMessageId);
  if (direct) {
    return direct;
  }

  // Fallback: the attempt history carries the provider reference + the
  // PART 02 delivery_id linkage (covers rows whose ledger reference was
  // overwritten by a later attempt).
  const attempt = await getPool().query<{ deliveryId: string }>(
    `SELECT delivery_id AS "deliveryId"
       FROM notification_whatsapp_deliveries
      WHERE provider_reference = $1 AND delivery_id IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [providerMessageId],
  );
  const deliveryId = attempt.rows[0]?.deliveryId;
  if (!deliveryId) {
    return null;
  }
  return ledgerRepository.findById(deliveryId);
}

/** Emits the operational feedback event for one accepted transition. */
async function recordFeedbackEvent(
  record: OutboundDeliveryRecord,
  providerMessageId: string,
): Promise<void> {
  const eventType =
    record.providerFeedbackStatus === 'PROVIDER_FAILED'
      ? WHATSAPP_CALLBACK_EVENT_TYPES.PROVIDER_FAILED
      : WHATSAPP_CALLBACK_EVENT_TYPES.DELIVERED;

  await recordOperationalEvent({
    clientId: record.clientId,
    eventType,
    entityType: 'NOTIFICATION_DELIVERY',
    entityId: record.id,
    buildingId: record.buildingId,
    summary: `Outbound WHATSAPP delivery feedback: ${record.providerFeedbackStatus} (provider meta)`,
    metadata: {
      channel: record.channel,
      provider: 'meta',
      providerMessageId,
      feedbackStatus: record.providerFeedbackStatus,
      attemptCount: record.attemptCount,
      ...(record.feedbackError ? { error: record.feedbackError } : {}),
    },
  });
}

/** Extracts a sanitized error from a Meta `failed` status, when present. */
function feedbackErrorOf(status: MetaWhatsAppStatusUpdate): string | null {
  const first = status.errors?.[0];
  if (!first) {
    return null;
  }
  const code = typeof first.code === 'number' ? first.code : null;
  const message =
    typeof first.message === 'string' && first.message.length > 0
      ? first.message
      : 'Meta reported a delivery failure.';
  const prefixed = code !== null ? `Meta error ${code}: ${message}` : message;
  return sanitizeWhatsAppFeedbackError(prefixed);
}

/**
 * Processes one verified Meta webhook payload. Returns counters; every
 * unrecognized, duplicate, or out-of-order update is a safe skip, and the
 * caller always answers Meta 200 after signature verification.
 */
export async function processMetaWhatsAppCallbackPayload(
  payload: MetaWhatsAppWebhookPayload,
  at: Date = new Date(),
): Promise<WhatsAppCallbackProcessingResult> {
  const result: WhatsAppCallbackProcessingResult = {
    statuses: 0,
    applied: 0,
    skipped: 0,
  };

  const statuses: MetaWhatsAppStatusUpdate[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const updates = change.value?.statuses;
      if (Array.isArray(updates)) {
        statuses.push(...updates);
      }
    }
  }
  result.statuses = statuses.length;

  for (const status of statuses) {
    const providerMessageId =
      typeof status.id === 'string' && status.id.length > 0 ? status.id : null;
    const feedbackStatus = mapMetaStatusToFeedback(status.status);

    // `sent` (already recorded as acceptance) and unknown statuses: no-op.
    if (!providerMessageId || !feedbackStatus) {
      result.skipped += 1;
      continue;
    }

    const delivery = await correlateDelivery(providerMessageId);
    if (!delivery || delivery.channel !== 'WHATSAPP') {
      result.skipped += 1;
      continue;
    }

    const updated = await ledgerRepository.applyDeliveryFeedback(delivery.id, {
      feedbackStatus,
      feedbackAt: at,
      feedbackError: feedbackStatus === 'PROVIDER_FAILED' ? feedbackErrorOf(status) : null,
    });

    // Guard matched nothing: not SENT (e.g. still retrying) or feedback
    // already recorded (duplicate/out-of-order) — always a safe no-op.
    if (!updated) {
      result.skipped += 1;
      continue;
    }

    await recordFeedbackEvent(updated, providerMessageId);
    result.applied += 1;
  }

  return result;
}

import { createHash } from 'node:crypto';
import {
  isOutboundDeliveryChannel,
  type OutboundDeliveryChannel,
} from './outbound-delivery.types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 02 — delivery-level idempotency authority.
 *
 * Governance §7.1: the idempotency key is the deterministic digest of the
 * intent identity —
 *
 *   sha256(source_event_type | source_entity_id | channel |
 *          recipient_user_id | template_key)
 *
 * combined with the row's `client_id` in the ledger's
 * `UNIQUE (client_id, channel, idempotency_key)` constraint. A replayed
 * intent therefore inserts nothing: the idempotent creation seam returns the
 * existing row instead.
 *
 * Components are normalized before hashing (event type / channel uppercase,
 * UUIDs lowercase, surrounding whitespace trimmed) so key equality is a
 * property of the intent identity, not of its string presentation.
 *
 * CR-BE-PUSH-01 PART 03A: this authority is UNCHANGED by the PUSH widening.
 * `channel` was already a hashed component and already part of the ledger's
 * `UNIQUE (client_id, channel, idempotency_key)` constraint, so a PUSH intent
 * derives a distinct key and can never collide with the EMAIL/WHATSAPP row of
 * the same event (governance §11.2). The key stays RECIPIENT-based — it is
 * deliberately not device-aware, because a device-aware key would multiply
 * per device and break replay suppression when a user adds or removes one.
 */

export type OutboundDeliveryIdempotencyInput = {
  sourceEventType: string;
  sourceEntityId: string;
  channel: OutboundDeliveryChannel;
  recipientUserId: string;
  templateKey: string;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

/**
 * Computes the delivery-level idempotency key for one intent. Pure and
 * deterministic; throws on malformed identity components so a bad key can
 * never silently weaken duplicate suppression.
 */
export function computeOutboundDeliveryIdempotencyKey(
  input: OutboundDeliveryIdempotencyInput,
): string {
  const sourceEventType = input.sourceEventType.trim().toUpperCase();
  const sourceEntityId = input.sourceEntityId.trim().toLowerCase();
  const channel = input.channel.trim().toUpperCase();
  const recipientUserId = input.recipientUserId.trim().toLowerCase();
  const templateKey = input.templateKey.trim();

  if (!EVENT_TYPE_PATTERN.test(sourceEventType)) {
    throw new Error(
      'computeOutboundDeliveryIdempotencyKey: sourceEventType must be a non-empty code (letters, digits, underscore).',
    );
  }
  if (!UUID_PATTERN.test(sourceEntityId)) {
    throw new Error(
      'computeOutboundDeliveryIdempotencyKey: sourceEntityId must be a valid UUID.',
    );
  }
  if (!isOutboundDeliveryChannel(channel)) {
    throw new Error(
      'computeOutboundDeliveryIdempotencyKey: channel must be EMAIL, WHATSAPP or PUSH.',
    );
  }
  if (!UUID_PATTERN.test(recipientUserId)) {
    throw new Error(
      'computeOutboundDeliveryIdempotencyKey: recipientUserId must be a valid UUID.',
    );
  }
  if (templateKey.length === 0) {
    throw new Error(
      'computeOutboundDeliveryIdempotencyKey: templateKey must be a non-empty string.',
    );
  }

  return createHash('sha256')
    .update(
      [sourceEventType, sourceEntityId, channel, recipientUserId, templateKey].join('|'),
    )
    .digest('hex');
}

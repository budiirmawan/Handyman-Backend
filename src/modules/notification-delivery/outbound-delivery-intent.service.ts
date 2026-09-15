import { getPool } from '../../database';
import {
  computeOutboundDeliveryIdempotencyKey,
  notificationOutboundDeliveryRepository,
  type OutboundDeliveryChannel,
} from '../notification-outbound-deliveries';
import { getActiveTemplateByKey, renderTemplate } from '../notification-templates';
import { findMatchingSubscriptions } from '../notification-subscriptions';
import { resolveRecipients } from '../recipient-resolution';
import { normalizeDeliveryEvent } from './notification-delivery-event';
import type {
  NotificationDeliveryEvent,
  OutboundDeliveryIntentResult,
} from './notification-delivery.types';

/**
 * CR-BE-NOTIFY-PROV-01 PART 03 — outbound intent orchestration.
 *
 * Turns an occurred domain event into durable EMAIL / WHATSAPP / PUSH
 * delivery INTENTS on the PART 02 ledger (PUSH added by CR-BE-PUSH-01
 * PART 03A), composing the existing authorities without duplicating any of
 * them:
 *
 *   1. BE-26D — find ACTIVE subscriptions matching the event type + context,
 *   2. BE-26B — render the referenced template ONCE (ACTIVE + outbound
 *      channel only), snapshotting subject/message,
 *   3. BE-26C — resolve recipients from the subscription's rule,
 *   4. PART 02 — create one ledger row per (channel, recipient) through the
 *      idempotent `createOnConflictReturn` seam (rendered-once content +
 *      resolved address snapshot + idempotency key).
 *
 * INTENT ONLY: this seam never claims a row, never calls an adapter, and
 * never contacts a provider — claim/send execution and retry are PART 04.
 * Business domains remain the source of truth; this service only reacts to
 * an event that already occurred. The IN_APP chain (BE-26E) is untouched:
 * subscriptions with IN_APP templates are skipped here and stay the
 * `deliverInAppNotifications` authority.
 */

/**
 * The outbound channels this seam creates intents for.
 *
 * CR-BE-PUSH-01 PART 03A widens the list with PUSH. The widening is generic:
 * PUSH travels the SAME subscription → template → recipient → ledger path as
 * EMAIL and WHATSAPP, with no push-specific queue, outbox, scheduler or
 * branch anywhere in the intent flow. EMAIL/WHATSAPP semantics are unchanged.
 */
const OUTBOUND_CHANNELS: readonly OutboundDeliveryChannel[] = [
  'EMAIL',
  'WHATSAPP',
  'PUSH',
];

/**
 * Resolves the recipient's delivery address for one outbound channel from the
 * AUTHORITATIVE sources only (governance §4.4 / §5.3):
 *
 *   - EMAIL    — `users.email` of an ACTIVE user (the identity master),
 *   - WHATSAPP — `users.whatsapp_phone` of an ACTIVE user under the explicit
 *     consent-active rule; no number is ever derived, scraped, or guessed,
 *   - PUSH     — the RECIPIENT, not a device: the stable literal
 *     `user:<userId>` for an ACTIVE user (CR-BE-PUSH-01 §10.2).
 *
 * Why PUSH resolves to a person rather than a token: one user owns N devices.
 * Putting a token here would force one ledger row per device, multiply the
 * recipient-based idempotency key, couple the ledger to device churn, and
 * write a credential-grade secret into a queryable column. Device selection
 * is therefore a SEND-time concern (PART 03B fan-out) and the ledger stays
 * device-agnostic and device-count-independent.
 */
async function resolveOutboundRecipientAddress(
  channel: OutboundDeliveryChannel,
  recipientUserId: string,
): Promise<string | null> {
  if (channel === 'PUSH') {
    // Address the person; never a token, never a device id. The ACTIVE-user
    // guard matches the other channels: a deactivated user resolves to null
    // and is counted as a skip, exactly as EMAIL/WHATSAPP already behave.
    const result = await getPool().query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE'`,
      [recipientUserId],
    );
    const id = result.rows[0]?.id;
    return id ? `user:${id}` : null;
  }

  if (channel === 'EMAIL') {
    const result = await getPool().query<{ email: string }>(
      `SELECT email FROM users WHERE id = $1 AND status = 'ACTIVE'`,
      [recipientUserId],
    );
    const email = result.rows[0]?.email?.trim();
    return email && email.length > 0 ? email : null;
  }

  // WHATSAPP (CR-BE-NOTIFY-PROV-01 PART 06): the authoritative contact is
  // users.whatsapp_phone, guarded by the explicit consent-active rule —
  // ACTIVE user, phone present, opted in, and the last opt-in newer than any
  // opt-out. No number is ever inferred from tenant/vendor PIC contact data.
  const result = await getPool().query<{ whatsapp_phone: string }>(
    `SELECT whatsapp_phone
       FROM users
      WHERE id = $1
        AND status = 'ACTIVE'
        AND whatsapp_phone IS NOT NULL
        AND whatsapp_opted_in_at IS NOT NULL
        AND (whatsapp_opted_out_at IS NULL OR whatsapp_opted_in_at > whatsapp_opted_out_at)`,
    [recipientUserId],
  );
  return result.rows[0]?.whatsapp_phone ?? null;
}

/**
 * Creates outbound delivery intents (PART 02 ledger rows) for an occurred
 * domain event on the requested outbound channels.
 *
 * `channels` defaults to both outbound channels; a run only ever creates
 * rows for templates whose (widened, PART 03) channel is in the list. The
 * result counters make every skip and every idempotent replay observable.
 * Noop/capture-compatible by construction: intent creation is provider-free,
 * and the produced ledger rows are exactly what the PART 04 execution path
 * (adapter-resolving, claim-before-send) consumes.
 */
export async function deliverOutboundNotifications(
  event: NotificationDeliveryEvent,
  channels: readonly OutboundDeliveryChannel[] = OUTBOUND_CHANNELS,
): Promise<OutboundDeliveryIntentResult> {
  const normalized = normalizeDeliveryEvent(event);
  const requested = channels.filter((channel): channel is OutboundDeliveryChannel =>
    OUTBOUND_CHANNELS.includes(channel),
  );

  const result: OutboundDeliveryIntentResult = {
    eventType: normalized.eventType,
    channels: requested,
    subscriptionsMatched: 0,
    templatesSkipped: 0,
    recipientsResolved: 0,
    recipientsSkipped: 0,
    deliveriesCreated: 0,
    duplicatesSuppressed: 0,
  };

  const subscriptions = await findMatchingSubscriptions(normalized.eventType, {
    clientId: normalized.clientId,
    ...(normalized.buildingId ? { buildingId: normalized.buildingId } : {}),
  });
  result.subscriptionsMatched = subscriptions.length;

  for (const subscription of subscriptions) {
    // Only ACTIVE templates render. A deactivated template yields no intents
    // for this subscription (the subscription stays ACTIVE for when it is
    // re-enabled) — identical to the BE-26E semantics.
    const template = await getActiveTemplateByKey(subscription.templateKey);
    if (!template) {
      result.templatesSkipped += 1;
      continue;
    }

    // IN_APP templates stay the deliverInAppNotifications authority;
    // non-requested outbound channels are filtered by the run's channel list.
    const channel = template.channel as OutboundDeliveryChannel | 'IN_APP';
    if (channel === 'IN_APP' || !requested.includes(channel)) {
      result.templatesSkipped += 1;
      continue;
    }

    // Render ONCE at intent time: the snapshot on each ledger row is immune
    // to later template edits (SLA-02 snapshot-on-schedule precedent).
    const rendered = renderTemplate(
      { subject: template.subject, body: template.body },
      normalized.variables,
    );
    const message = rendered.body ?? rendered.subject;

    const recipientIds = await resolveRecipients(
      subscription.recipientRule.specs,
      subscription.recipientRule.scope,
    );
    result.recipientsResolved += recipientIds.length;

    for (const recipientUserId of recipientIds) {
      const recipientAddress = await resolveOutboundRecipientAddress(
        channel,
        recipientUserId,
      );
      if (!recipientAddress) {
        result.recipientsSkipped += 1;
        continue;
      }

      const idempotencyKey = computeOutboundDeliveryIdempotencyKey({
        sourceEventType: normalized.eventType,
        sourceEntityId: normalized.entityId,
        channel,
        recipientUserId,
        templateKey: subscription.templateKey,
      });

      const { created } = await notificationOutboundDeliveryRepository.createOnConflictReturn({
        clientId: normalized.clientId,
        buildingId: normalized.buildingId,
        recipientUserId,
        channel,
        templateKey: subscription.templateKey,
        sourceEventType: normalized.eventType,
        sourceEntityType: normalized.entityType,
        sourceEntityId: normalized.entityId,
        // EMAIL carries the rendered subject; WHATSAPP and PUSH have no
        // subject line of their own (a PUSH title is derived at send time
        // from the snapshotted content, CR-BE-PUSH-01 §9).
        subject: channel === 'EMAIL' ? rendered.subject : null,
        message,
        recipientAddress,
        idempotencyKey,
      });

      if (created) {
        result.deliveriesCreated += 1;
      } else {
        result.duplicatesSuppressed += 1;
      }
    }
  }

  return result;
}

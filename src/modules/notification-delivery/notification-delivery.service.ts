import { recordNotification } from '../notifications';
import { getActiveTemplateByKey, renderTemplate } from '../notification-templates';
import { findMatchingSubscriptions } from '../notification-subscriptions';
import { resolveRecipients } from '../recipient-resolution';
import { normalizeDeliveryEvent } from './notification-delivery-event';
import type {
  InAppDeliveryEvent,
  InAppDeliveryResult,
  NotificationDeliveryExecutor,
} from './notification-delivery.types';
import { getPool } from '../../database';

/**
 * BE-26E — In-app delivery service.
 *
 * Delivers notifications inside the Asentra application by composing the
 * existing foundations, without duplicating workflow logic:
 *
 *   1. BE-26D — find ACTIVE subscriptions matching the event type + context,
 *   2. BE-26B — render the referenced template (ACTIVE templates only),
 *   3. BE-26C — resolve recipients from the subscription's rule,
 *   4. BE-26A — create the in-app notification record (the delivery record)
 *      for each recipient, stamped with `templateKey` and `deliveredAt`.
 *
 * Business domains remain the source of truth; this service only reacts to
 * an event that already occurred. No email / WhatsApp / push delivery here.
 *
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 — two ADDITIVE seams:
 *
 *   - `executor` — the chain may run on the caller's open transaction, so a
 *     notification record commits or rolls back with the domain fact that
 *     produced it. The default stays the pool.
 *   - `event.recipients` — when the producing domain knows the authoritative
 *     recipient set (an assignment knows its assignee), the chain delivers
 *     to those recipients instead of resolving them from the subscription
 *     rule. The subscription still owns the channel/template selection.
 */

/**
 * Delivers in-app notifications for an occurred domain event. Returns a
 * summary; the created records are immediately visible in the recipients'
 * inbox (BE-26A list endpoint).
 *
 * Event validation/normalization is shared with the outbound intent chain
 * (CR-BE-NOTIFY-PROV-01 PART 03) via `normalizeDeliveryEvent`.
 */
export async function deliverInAppNotifications(
  event: InAppDeliveryEvent,
  executor: NotificationDeliveryExecutor = getPool(),
): Promise<InAppDeliveryResult> {
  const normalized = normalizeDeliveryEvent(event);

  const subscriptions = await findMatchingSubscriptions(
    normalized.eventType,
    {
      clientId: normalized.clientId,
      ...(normalized.buildingId ? { buildingId: normalized.buildingId } : {}),
    },
    executor,
  );

  let recipientsResolved = 0;
  let notificationsCreated = 0;

  for (const subscription of subscriptions) {
    // Only ACTIVE templates render. A deactivated template yields no delivery
    // for this subscription (the subscription stays ACTIVE for when it is
    // re-enabled).
    const template = await getActiveTemplateByKey(
      subscription.templateKey,
      executor,
    );
    if (!template) {
      continue;
    }

    const rendered = renderTemplate(
      { subject: template.subject, body: template.body },
      normalized.variables,
    );

    // The AUTHORITATIVE recipient set wins when the producing domain supplied
    // one; otherwise the subscription's recipient rule resolves the audience
    // (BE-26C) exactly as before.
    const recipientIds = normalized.recipients
      ? normalized.recipients
      : await resolveRecipients(
          subscription.recipientRule.specs,
          subscription.recipientRule.scope,
        );
    recipientsResolved += recipientIds.length;

    for (const recipientUserId of recipientIds) {
      await recordNotification(
        {
          clientId: normalized.clientId,
          recipientUserId,
          type: template.type,
          channel: 'IN_APP',
          title: rendered.subject,
          body: rendered.body,
          sourceEntityType: normalized.entityType,
          sourceEntityId: normalized.entityId,
          sourceEventType: normalized.eventType,
          templateKey: subscription.templateKey,
          metadata: { subscriptionKey: subscription.key },
        },
        executor,
      );
      notificationsCreated += 1;
    }
  }

  return {
    eventType: normalized.eventType,
    subscriptionsMatched: subscriptions.length,
    recipientsResolved,
    notificationsCreated,
  };
}

export const notificationDeliveryService = {
  deliverInAppNotifications,
};

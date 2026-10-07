import { AppError } from '../../shared/errors';
import {
  deliverInAppNotifications,
  deliverOutboundNotifications,
} from '../notification-delivery';
import type {
  InAppDeliveryResult,
  NotificationDeliveryEvent,
  OutboundDeliveryIntentResult,
} from '../notification-delivery';
import {
  handymanNotificationContractFor,
  isHandymanNotificationEventType,
  type HandymanNotificationContractEntry,
} from './handyman-notification-contract';

/**
 * CR-HM-16 PART 02 — Handyman notification intent seam (governance
 * `docs/handyman/CR-HM-16_START_GOVERNANCE.md` §7 seam 2, §9 PART 02 row).
 *
 * WHAT THIS OWNS
 * --------------
 * The single admission point that binds an admitted Handyman SLA/domain event
 * to the EXISTING notification INTENT flow. It validates the event against the
 * frozen contract (fail-closed: anything not admitted is rejected and produces
 * zero intent), then reacts through the reused BE-26 seams only:
 *
 *   - `deliverInAppNotifications` (BE-26E) — subscription → template →
 *     recipients → in-app notification records,
 *   - `deliverOutboundNotifications` (CR-BE-NOTIFY-PROV-01 PART 03) —
 *     subscription → template → recipients → durable outbound delivery LEDGER
 *     intents (intent only; claim/send execution and providers stay the reused
 *     delivery lifecycle).
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No notification stack, no scheduler, no outbox, no provider adapter, no
 * channel choice — all inherited by reference from the reused capability.
 * Provider-neutral: no WhatsApp or any named provider is a dependency of the
 * contract or this seam. REACTIVE ONLY: notifications are produced for an
 * event that already occurred; this seam never writes (nor reads) Handyman
 * lifecycle state. No audit/performance work, no HTTP surface.
 */

/** An admitted Handyman event being emitted to the notification INTENT flow. */
export type HandymanNotificationEvent = Omit<NotificationDeliveryEvent, 'eventType'> & {
  eventType: string;
};

/** Combined intent summary across the reused chains (observability only). */
export type HandymanNotificationIntentResult = {
  contract: Pick<HandymanNotificationContractEntry, 'eventType' | 'meaning' | 'audience' | 'templateKey'>;
  inApp: InAppDeliveryResult;
  outbound: OutboundDeliveryIntentResult;
};

/**
 * Emits notification intent for one admitted Handyman SLA/domain event.
 * Fail-closed admission: an event type outside the frozen contract throws a
 * validation error and no intent row of any kind is created.
 */
export async function emitHandymanNotificationIntent(
  event: HandymanNotificationEvent,
): Promise<HandymanNotificationIntentResult> {
  const contract = handymanNotificationContractFor(event.eventType);
  if (!isHandymanNotificationEventType(event.eventType) || !contract) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'eventType',
        message: 'eventType must be an admitted Handyman notification event type.',
      },
    ]);
  }
  const inApp = await deliverInAppNotifications(event);
  const outbound = await deliverOutboundNotifications(event);
  return {
    contract: {
      eventType: contract.eventType,
      meaning: contract.meaning,
      audience: contract.audience,
      templateKey: contract.templateKey,
    },
    inApp,
    outbound,
  };
}

export const handymanNotificationIntentService = { emitHandymanNotificationIntent };

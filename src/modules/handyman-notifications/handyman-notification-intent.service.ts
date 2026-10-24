import { AppError } from '../../shared/errors';
import {
  deliverInAppNotifications,
  deliverOutboundNotifications,
} from '../notification-delivery';
import type {
  InAppDeliveryResult,
  NotificationDeliveryEvent,
  NotificationDeliveryExecutor,
  OutboundDeliveryIntentResult,
} from '../notification-delivery';
import type { OutboundDeliveryChannel } from '../notification-outbound-deliveries';
import {
  handymanNotificationContractFor,
  isHandymanNotificationEventType,
  type HandymanNotificationAudience,
  type HandymanNotificationContractEntry,
} from './handyman-notification-contract';
import {
  handymanAssignmentNotificationContractFor,
  isHandymanAssignmentNotificationEventType,
  type HandymanAssignmentNotificationAudience,
} from './handyman-assignment-notification.contract';

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
 *
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 — the producer wiring
 * ----------------------------------------------------------
 * This seam is now the ONE Handyman notification producer, and it has real
 * callers: the assignment authorities.
 *
 * 1. ADMISSION WIDENED (additive). The seam now also admits the Handyman
 *    ASSIGNMENT vocabulary (`handyman-assignment-notification.contract.ts`).
 *    The CR-HM-16 PART 02 contract itself is UNCHANGED — the assignment
 *    vocabulary lives beside it, because an assignment's audience is the
 *    assignment FACT, not a declarative subscription rule. The audience
 *    authority of an assignment event is therefore `ASSIGNEE` / `OPERATIONS`
 *    (the fact) instead of `SUBSCRIPTION_RULE` (the rule).
 *
 * 2. EXECUTOR (additive). `options.executor` lets a producer that already
 *    owns a domain transaction write its notification intents ON that
 *    transaction, so the intent commits or rolls back with the domain fact.
 *    The default stays the pool.
 *
 * 3. AUTHORITATIVE RECIPIENTS (additive). `event.recipients` — supplied by
 *    the producing domain — is the audience of the event. The subscription
 *    still owns WHICH channel and WHICH template apply; the domain owns WHO
 *    the event is about.
 *
 * 4. IN-APP OWNERSHIP (additive). `options.deliverInApp = false` declares
 *    that the caller already owns the IN_APP record of this event (the
 *    assignment domain writes it, because the copy and the navigation target
 *    are assignment facts). The outbound intent chain still runs.
 */

/** An admitted Handyman event being emitted to the notification INTENT flow. */
export type HandymanNotificationEvent = Omit<NotificationDeliveryEvent, 'eventType'> & {
  eventType: string;
};

/**
 * The audience authority of an admitted Handyman event.
 *
 *   - `SUBSCRIPTION_RULE`    — a declarative BE-26D subscription names the
 *                              audience (CR-HM-16 PART 02 vocabulary),
 *   - `SLA_ESCALATION_POLICY`— the SLA escalation policy/level names it,
 *   - `ASSIGNEE` / `OPERATIONS` — the assignment FACT names it
 *                              (CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01).
 */
export type HandymanNotificationIntentAudience =
  | HandymanNotificationAudience
  | HandymanAssignmentNotificationAudience;

/** The contract view of the admitted event (observability, never persisted). */
export type HandymanNotificationIntentContractView = {
  eventType: string;
  meaning: string;
  audience: HandymanNotificationIntentAudience;
  templateKey: string;
};

/** Combined intent summary across the reused chains (observability only). */
export type HandymanNotificationIntentResult = {
  contract: HandymanNotificationIntentContractView;
  inApp: InAppDeliveryResult;
  outbound: OutboundDeliveryIntentResult;
};

/**
 * The optional producer controls of the seam.
 *
 * Every field is additive: a caller that passes nothing keeps the exact
 * CR-HM-16 PART 02 behaviour.
 */
export type HandymanNotificationIntentOptions = {
  /**
   * The executor the intents are written on. Defaults to the pool; pass the
   * producing domain's transaction client so the intent is atomic with the
   * domain fact that produced it.
   */
  executor?: NotificationDeliveryExecutor;
  /**
   * Whether the in-app chain runs. Defaults to `true`. `false` declares that
   * the caller already owns the IN_APP record of this event (the assignment
   * domain owns the copy and the navigation target of an assignment
   * notification); the outbound intent chain still runs.
   */
  deliverInApp?: boolean;
  /** The outbound channels this run may create intents for. */
  channels?: readonly OutboundDeliveryChannel[];
};

/**
 * Emits notification intent for one admitted Handyman SLA/domain/assignment
 * event. Fail-closed admission: an event type outside the admitted vocabularies
 * throws a validation error and no intent row of any kind is created.
 */
export async function emitHandymanNotificationIntent(
  event: HandymanNotificationEvent,
  options: HandymanNotificationIntentOptions = {},
): Promise<HandymanNotificationIntentResult> {
  const contract = resolveAdmittedContract(event.eventType);
  if (!contract) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'eventType',
        message: 'eventType must be an admitted Handyman notification event type.',
      },
    ]);
  }
  const executor = options.executor;
  const inApp =
    options.deliverInApp === false
      ? {
          eventType: event.eventType.trim().toUpperCase(),
          subscriptionsMatched: 0,
          recipientsResolved: 0,
          notificationsCreated: 0,
        }
      : await deliverInAppNotifications(event, executor);
  const outbound = await deliverOutboundNotifications(
    event,
    options.channels,
    executor,
  );
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

/**
 * The admitted contract of one event type, across BOTH Handyman
 * vocabularies: the CR-HM-16 PART 02 lifecycle/SLA vocabulary and the
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 01 assignment vocabulary.
 * `undefined` means "not admitted" — the seam then fails closed.
 */
function resolveAdmittedContract(
  eventType: string,
): HandymanNotificationIntentContractView | undefined {
  if (isHandymanNotificationEventType(eventType)) {
    const entry = handymanNotificationContractFor(eventType);
    if (entry) {
      return {
        eventType: entry.eventType,
        meaning: entry.meaning,
        audience: entry.audience,
        templateKey: entry.templateKey,
      };
    }
  }
  if (isHandymanAssignmentNotificationEventType(eventType)) {
    const entry = handymanAssignmentNotificationContractFor(eventType);
    if (entry) {
      return {
        eventType: entry.eventType,
        meaning: entry.meaning,
        audience: entry.audience,
        templateKey: entry.templateKey,
      };
    }
  }
  return undefined;
}

export const handymanNotificationIntentService = { emitHandymanNotificationIntent };

/** Re-exported so consumers can narrow the CR-HM-16 contract entry type. */
export type { HandymanNotificationContractEntry };

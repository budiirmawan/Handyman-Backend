import { AppError } from '../../shared/errors';
import type {
  InAppDeliveryResult,
  NotificationDeliveryExecutor,
  OutboundDeliveryIntentResult,
} from '../notification-delivery';
import {
  handymanDomainNotificationEntityTypeFor,
  type HandymanDomainNotificationEntityType,
  type HandymanDomainNotificationEventType,
} from './handyman-domain-notification.contract';
import { emitHandymanNotificationIntent } from './handyman-notification-intent.service';

/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — the Handyman DOMAIN
 * notification producer.
 *
 * WHAT THIS OWNS
 * --------------
 * The ONE place where a Handyman LIFECYCLE domain authority turns an
 * occurred fact into a notification intent. It is a thin, fail-safe wrapper
 * around the PART 01 producer seam
 * (`emitHandymanNotificationIntent`) and adds nothing to the delivery
 * stack:
 *
 *   - the EVENT IDENTITY is bound to the notification entity by
 *     `handyman-domain-notification.contract.ts` (never by the call site),
 *   - the TENANT is the domain fact's own `clientId` — never asserted by a
 *     caller and never taken from the request body,
 *   - the AUDIENCE stays the declarative BE-26D subscription rule (the
 *     frozen contract's `SUBSCRIPTION_RULE`); this producer never overrides
 *     it,
 *   - the intents are written ON the caller's transaction, so the
 *     notification commits — or rolls back — with the fact that produced
 *     it (the transactional-outbox guarantee).
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No notification engine, no scheduler, no queue, no provider adapter, no
 * channel choice, no template, no recipient resolution. Those are the reused
 * BE-26 / CR-BE-NOTIFY-PROV-01 / CR-BE-PUSH-01 capabilities, reached through
 * the PART 01 seam. The IN_APP record, the durable outbound ledger row, the
 * idempotency key and the channel fan-out are all inherited unchanged.
 *
 * FAIL-SAFE
 * ---------
 * A notification CONFIGURATION failure (an unknown event type, a template
 * whose variables the event cannot satisfy, an invalid template reference)
 * must never break a domain command: the lifecycle fact is the authority and
 * the notification only REACTS to it. Such a failure is reported on the
 * result. A DATABASE failure is fatal and propagates: the transaction must
 * roll back rather than commit a half-written fact.
 */

/** The input of one produced Handyman domain notification. */
export type HandymanDomainNotificationInput = {
  /** The admitted domain event type (the frozen vocabulary + PART 03). */
  eventType: string;
  /** The tenant of the OCCURRED FACT (the domain's own client id). */
  clientId: string;
  /**
   * The id of the OCCURRENCE the event addresses (the triage decision, the
   * referral, the cancellation, the inspection, the quotation version, the
   * readiness row, the crew membership, the crew lead row). The notification
   * entity TYPE is resolved by the contract, never by the caller.
   */
  entityId: string;
  /** The building the fact belongs to, when it has one. */
  buildingId?: string | null;
  /** The template variable values of the event. */
  variables?: Record<string, string | number>;
};

/** The optional producer controls. */
export type HandymanDomainNotificationOptions = {
  /**
   * The executor the intents are written on. Defaults to the pool; pass the
   * producing domain's transaction client so the intent is atomic with the
   * domain fact that produced it.
   */
  executor?: NotificationDeliveryExecutor;
};

/** The outcome of one produced domain notification (observability). */
export type HandymanDomainNotificationResult = {
  /** The event type the producer was asked to emit. */
  eventType: string;
  /** The notification entity the event addresses (null when not produced). */
  entityType: HandymanDomainNotificationEntityType | null;
  /** True when the reused chains ran for this event. */
  emitted: boolean;
  /** The in-app chain summary (null when nothing was emitted). */
  inApp: InAppDeliveryResult | null;
  /** The outbound intent chain summary (null when nothing was emitted). */
  outbound: OutboundDeliveryIntentResult | null;
  /**
   * The notification CONFIGURATION failure that stopped the run, when one
   * happened. The domain command is never failed by it.
   */
  error: string | null;
};

/**
 * Produces the notification intents of one occurred Handyman domain event.
 *
 * Fail-closed on an event type outside the produced vocabulary (nothing is
 * written), fail-safe on a notification configuration failure (nothing is
 * written, the domain command still succeeds), and atomic on the caller's
 * transaction (the intents commit or roll back with the domain fact).
 */
export async function emitHandymanDomainNotificationIntent(
  input: HandymanDomainNotificationInput,
  options: HandymanDomainNotificationOptions = {},
): Promise<HandymanDomainNotificationResult> {
  const entityType = handymanDomainNotificationEntityTypeFor(input.eventType);
  if (!entityType) {
    // Not an admitted produced event: the domain fact still commits, and
    // NOTHING of the notification stack runs.
    return {
      eventType: input.eventType,
      entityType: null,
      emitted: false,
      inApp: null,
      outbound: null,
      error: null,
    };
  }

  try {
    const intent = await emitHandymanNotificationIntent(
      {
        eventType: input.eventType,
        clientId: input.clientId,
        entityType,
        entityId: input.entityId,
        buildingId: input.buildingId ?? null,
        variables: input.variables ?? {},
      },
      { executor: options.executor },
    );
    return {
      eventType: intent.contract.eventType,
      entityType,
      emitted: true,
      inApp: intent.inApp,
      outbound: intent.outbound,
      error: null,
    };
  } catch (error) {
    if (!(error instanceof AppError)) {
      // A DATABASE failure (or any unexpected error) is fatal: the
      // transaction must roll back rather than commit a half-written fact.
      throw error;
    }
    return {
      eventType: input.eventType,
      entityType,
      emitted: false,
      inApp: null,
      outbound: null,
      error: error.message,
    };
  }
}

export const handymanDomainNotificationProducerService = {
  emitHandymanDomainNotificationIntent,
};

/** Re-exported so consumers can narrow the produced event vocabulary. */
export type { HandymanDomainNotificationEventType };

/**
 * BE-26E — In-app delivery types.
 * CR-BE-NOTIFY-PROV-01 PART 03 — outbound intent types.
 *
 * Delivery composes the BE-26 notification foundations into delivery actions
 * from an existing domain event:
 *
 *   event → BE-26D matching subscriptions → BE-26B template render
 *         → BE-26C recipient resolution → delivery records.
 *
 * The IN_APP chain produces in-app notification records (BE-26A). The
 * outbound chain (PART 03) produces PART 02 delivery-ledger intents for
 * EMAIL / WHATSAPP — no provider contact, no claim/send execution here.
 */

import type { OutboundDeliveryChannel } from '../notification-outbound-deliveries';

/**
 * An existing backend domain event being reacted to. `eventType` mirrors
 * `operational_events.event_type`; `clientId`/`entityType`/`entityId` carry
 * the source event's authoritative context (never client-supplied scope).
 * Shared by the in-app chain (BE-26E) and the outbound intent chain
 * (CR-BE-NOTIFY-PROV-01 PART 03).
 */
export type NotificationDeliveryEvent = {
  eventType: string;
  clientId: string;
  entityType: string;
  entityId: string;
  buildingId?: string | null;
  /** Template variable values used when rendering the notification. */
  variables?: Record<string, string | number>;
};

/** BE-26E compatibility alias (the in-app chain's original event type). */
export type InAppDeliveryEvent = NotificationDeliveryEvent;

/** Summary of an in-app delivery run (for observability, not persisted). */
export type InAppDeliveryResult = {
  eventType: string;
  subscriptionsMatched: number;
  recipientsResolved: number;
  notificationsCreated: number;
};

/**
 * Summary of an outbound intent run (CR-BE-NOTIFY-PROV-01 PART 03).
 *
 * The run is intent-only: it creates PART 02 ledger rows (one per channel +
 * recipient) and never contacts an adapter. Counters make replays and skips
 * observable:
 *   - `deliveriesCreated`     — new ledger rows,
 *   - `duplicatesSuppressed`  — idempotency-key hits returning existing rows,
 *   - `recipientsSkipped`     — recipients with no resolvable contact address
 *                               (e.g. WHATSAPP before a governed phone source
 *                               exists, governance §5.3),
 *   - `templatesSkipped`      — subscriptions whose template is INACTIVE,
 *                               IN_APP (in-app chain's authority), or on a
 *                               channel this run did not request.
 */
export type OutboundDeliveryIntentResult = {
  eventType: string;
  channels: readonly OutboundDeliveryChannel[];
  subscriptionsMatched: number;
  templatesSkipped: number;
  recipientsResolved: number;
  recipientsSkipped: number;
  deliveriesCreated: number;
  duplicatesSuppressed: number;
};

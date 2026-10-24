/**
 * CR-HM-MULTICLIENT-NOTIFICATION-01 PART 03 — Handyman DOMAIN notification
 * event contract (the producer side of the CR-HM-16 PART 02 vocabulary).
 *
 * POSITION
 * --------
 * The CR-HM-16 PART 02 contract (`handyman-notification-contract.ts`) froze
 * the notification MEANING of eleven Handyman LIFECYCLE events (request
 * triaged, referral created, request cancelled, quotation issued /
 * superseded / expired, permit / scheduling / unit-access readiness created,
 * crew member added, crew lead designated). Until now those eleven events
 * were NAMED but never PRODUCED: no domain authority emitted a notification
 * intent for them. PART 03 wires them.
 *
 * This file holds the PART 03 additions, in the SAME additive shape PART 01
 * established for the assignment vocabulary: the frozen CR-HM-16 contract is
 * left BYTE-FOR-BYTE untouched, and everything PART 03 needs beyond it lives
 * beside it, here.
 *
 * WHAT THIS OWNS
 * --------------
 *  1. `HANDYMAN_PART03_NOTIFICATION_CONTRACT` — the ONE event type that is
 *     NOT in the frozen contract but HAS a real source: the handyman
 *     inspection recorded on a service request
 *     (`HANDYMAN_INSPECTION_RECORDED`, journaled by
 *     `src/modules/handyman-requests/handyman-request-inspection.service.ts`).
 *  2. `HANDYMAN_DOMAIN_NOTIFICATION_FACTS` — the FACT BINDING of every
 *     produced event: which notification ENTITY (type) an event addresses.
 *     The id of that entity is the id of the OCCURRENCE (the triage
 *     decision, the referral, the cancellation, the inspection, the
 *     quotation version, the readiness row, the crew membership, the crew
 *     lead row) — never the aggregate, so two occurrences of the same
 *     event on the same aggregate can never collapse into one another
 *     (the outbound idempotency key is built from the entity id).
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No delivery, no channel, no provider, no transport, no persistence, no
 * audience override. The contract is CHANNEL-FREE and PROVIDER-FREE by law.
 * The audience of a domain event stays the declarative BE-26D subscription
 * rule (`SUBSCRIPTION_RULE`) — exactly as the frozen contract states. A
 * notification REACTS to an occurred event and never writes Handyman
 * lifecycle state.
 *
 * NO INVENTED EVENTS
 * ------------------
 * Every event type bound here is ALREADY emitted by a Handyman domain
 * authority as an operational-event journal row (the shared F6 authority).
 * This file names them and binds their notification entity; it does not
 * create an event, a business rule or a lifecycle authority.
 */

/**
 * The notification entity types the produced domain events address. Each one
 * names the OCCURRENCE row, so the notification's `sourceEntityType` /
 * `sourceEntityId` pair always points at a real, existing record.
 */
export const HANDYMAN_DOMAIN_NOTIFICATION_ENTITY_TYPES = [
  'HANDYMAN_REQUEST_TRIAGE_DECISION',
  'HANDYMAN_REQUEST_REFERRAL',
  'HANDYMAN_REQUEST_CANCELLATION',
  'HANDYMAN_REQUEST_INSPECTION',
  'HANDYMAN_QUOTATION_VERSION',
  'HANDYMAN_PERMIT_READINESS',
  'HANDYMAN_SCHEDULING_READINESS',
  'HANDYMAN_UNIT_ACCESS_READINESS',
  'HANDYMAN_WORK_CREW_MEMBERSHIP',
  'HANDYMAN_WORK_CREW_LEAD',
] as const;

export type HandymanDomainNotificationEntityType =
  (typeof HANDYMAN_DOMAIN_NOTIFICATION_ENTITY_TYPES)[number];

export function isHandymanDomainNotificationEntityType(
  value: unknown,
): value is HandymanDomainNotificationEntityType {
  return (
    typeof value === 'string' &&
    (HANDYMAN_DOMAIN_NOTIFICATION_ENTITY_TYPES as readonly string[]).includes(
      value,
    )
  );
}

/**
 * The PART 03 ADDITIVE vocabulary — the produced domain events that the
 * frozen CR-HM-16 PART 02 contract does not name.
 *
 * Exactly ONE entry today: the handyman inspection recorded on a service
 * request. It is a REAL lifecycle fact of the request flow (the bounded F2
 * inspection record, journaled as `HANDYMAN_INSPECTION_RECORDED` on the
 * shared append-only authority), it is NOT part of the frozen contract, and
 * the CR-HM-16 file stays untouched. Its audience is the same declarative
 * `SUBSCRIPTION_RULE` authority the frozen contract uses for every other
 * domain event: the subscription names the audience, the domain never does.
 */
export const HANDYMAN_PART03_NOTIFICATION_CONTRACT = [
  {
    eventType: 'HANDYMAN_INSPECTION_RECORDED',
    meaning:
      'A handyman inspection was recorded for a service request (the property was observed, or it could not be observed).',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_INSPECTION_RECORDED',
  },
] as const;

export type HandymanPart03NotificationContractEntry =
  (typeof HANDYMAN_PART03_NOTIFICATION_CONTRACT)[number];

export type HandymanPart03NotificationEventType =
  HandymanPart03NotificationContractEntry['eventType'];

export function isHandymanPart03NotificationEventType(
  value: unknown,
): value is HandymanPart03NotificationEventType {
  return (
    typeof value === 'string' &&
    (HANDYMAN_PART03_NOTIFICATION_CONTRACT as readonly { eventType: string }[]).some(
      (entry) => entry.eventType === value,
    )
  );
}

export function handymanPart03NotificationContractFor(
  eventType: string,
): HandymanPart03NotificationContractEntry | undefined {
  return (
    HANDYMAN_PART03_NOTIFICATION_CONTRACT as readonly HandymanPart03NotificationContractEntry[]
  ).find((entry) => entry.eventType === eventType);
}

/**
 * The FACT BINDING of every Handyman domain event PART 03 produces.
 *
 * The key is the event type (frozen CR-HM-16 vocabulary + the PART 03
 * additive vocabulary); the value is the notification entity the event
 * addresses. The producer resolves the entity type from HERE (never from a
 * call site), so a domain can never mislabel the subject of a notification.
 *
 * The id of that entity is the id of the OCCURRENCE:
 *   - the triage decision, the referral, the cancellation and the inspection
 *     are one-row-per-occurrence facts of the request flow,
 *   - a quotation version is the version (an issued, superseded or expired
 *     VERSION — never the quotation aggregate),
 *   - a readiness row is the ACTIVE readiness (the supersede path writes a
 *     NEW row, so the two occurrences never collide),
 *   - a crew membership is the membership that was added, and a crew lead
 *     row is the designation that was appended.
 */
export const HANDYMAN_DOMAIN_NOTIFICATION_FACTS = {
  HANDYMAN_REQUEST_TRIAGED: {
    entityType: 'HANDYMAN_REQUEST_TRIAGE_DECISION',
  },
  HANDYMAN_REFERRAL_CREATED: {
    entityType: 'HANDYMAN_REQUEST_REFERRAL',
  },
  HANDYMAN_REQUEST_CANCELLED: {
    entityType: 'HANDYMAN_REQUEST_CANCELLATION',
  },
  HANDYMAN_INSPECTION_RECORDED: {
    entityType: 'HANDYMAN_REQUEST_INSPECTION',
  },
  HANDYMAN_QUOTATION_ISSUED: {
    entityType: 'HANDYMAN_QUOTATION_VERSION',
  },
  HANDYMAN_QUOTATION_SUPERSEDED: {
    entityType: 'HANDYMAN_QUOTATION_VERSION',
  },
  HANDYMAN_QUOTATION_EXPIRED: {
    entityType: 'HANDYMAN_QUOTATION_VERSION',
  },
  HANDYMAN_PERMIT_READINESS_CREATED: {
    entityType: 'HANDYMAN_PERMIT_READINESS',
  },
  HANDYMAN_SCHEDULING_READINESS_CREATED: {
    entityType: 'HANDYMAN_SCHEDULING_READINESS',
  },
  HANDYMAN_UNIT_ACCESS_READINESS_CREATED: {
    entityType: 'HANDYMAN_UNIT_ACCESS_READINESS',
  },
  HANDYMAN_CREW_MEMBER_ADDED: {
    entityType: 'HANDYMAN_WORK_CREW_MEMBERSHIP',
  },
  HANDYMAN_CREW_LEAD_DESIGNATED: {
    entityType: 'HANDYMAN_WORK_CREW_LEAD',
  },
} as const satisfies Record<string, { entityType: HandymanDomainNotificationEntityType }>;

/** The event types PART 03 produces (the frozen vocabulary + the additive one). */
export type HandymanDomainNotificationEventType =
  | keyof typeof HANDYMAN_DOMAIN_NOTIFICATION_FACTS;

export function isHandymanDomainNotificationEventType(
  value: unknown,
): value is HandymanDomainNotificationEventType {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(
      HANDYMAN_DOMAIN_NOTIFICATION_FACTS,
      value,
    )
  );
}

/** The notification entity one produced domain event addresses. */
export function handymanDomainNotificationEntityTypeFor(
  eventType: string,
): HandymanDomainNotificationEntityType | undefined {
  const fact = (
    HANDYMAN_DOMAIN_NOTIFICATION_FACTS as Record<
      string,
      { entityType: HandymanDomainNotificationEntityType }
    >
  )[eventType];
  return fact?.entityType;
}

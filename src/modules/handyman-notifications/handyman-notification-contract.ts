/**
 * CR-HM-16 PART 02 — Handyman notification event contract (governance
 * `docs/handyman/CR-HM-16_START_GOVERNANCE.md` §4/§5, §7 seam 2, §9 PART 02
 * row: "Event→meaning/recipient/template contracts over BE-26 seams;
 * provider-neutral boundary; delivery/retry semantics inherited by reference").
 *
 * WHAT THIS OWNS
 * --------------
 * The frozen event→meaning/recipient/template mapping for Handyman
 * notification intent. Certified CR-HM-01..15 lifecycle vocabularies are the
 * `sourceEventType` inputs; this contract states, per event, its notification
 * MEANING, its recipient authority, and its canonical BE-26B template key.
 *
 * WHAT THIS NEVER OWNS
 * --------------------
 * No delivery, no channel, no provider. The contract is CHANNEL-FREE and
 * PROVIDER-FREE by law: no WhatsApp, email, push or any named provider appears
 * here (or in any emitted intent). Delivery status, retry/backoff and provider
 * adapters stay the reused BE-26 / CR-BE-NOTIFY-PROV-01 capability. A
 * notification REACTS to an occurred event and must never write Handyman
 * lifecycle state.
 *
 * RECIPIENT AUTHORITY
 * -------------------
 * - `SUBSCRIPTION_RULE` — the domain-event path: recipients come from the
 *   BE-26D `notification_subscriptions` recipient rule matched at emit time
 *   (declarative fan-out; Handyman defines event meaning only).
 * - `SLA_ESCALATION_POLICY` — the SLA path: recipients come from the SLA-02
 *   escalation policy/level snapshotted at breach time (materialized actions).
 */

/** Frozen notification-meaning entries for Handyman SLA and domain events. */
export const HANDYMAN_NOTIFICATION_CONTRACT = [
  // ---- SLA chain (shared engine events on Handyman subjects) -------------
  {
    eventType: 'SLA_CLOCK_BREACHED',
    meaning: 'A Handyman SLA milestone clock breached; the governed notification path is SLA escalation (policies/levels), with declarative fan-out available through subscriptions.',
    audience: 'SLA_ESCALATION_POLICY',
    templateKey: 'HANDYMAN_SLA_CLOCK_BREACHED',
  },
  {
    eventType: 'SLA_ESCALATION_TRIGGERED',
    meaning: 'An SLA breach escalation level produced notification intent for a Handyman subject.',
    audience: 'SLA_ESCALATION_POLICY',
    templateKey: 'HANDYMAN_SLA_ESCALATION_TRIGGERED',
  },
  // ---- Handyman domain events (certified CR-HM-01..15 vocabularies) ------
  {
    eventType: 'HANDYMAN_REQUEST_TRIAGED',
    meaning: 'A service request received its triage outcome.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_REQUEST_TRIAGED',
  },
  {
    eventType: 'HANDYMAN_REFERRAL_CREATED',
    meaning: 'A specialist referral/escalation was created for a service request.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_REFERRAL_CREATED',
  },
  {
    eventType: 'HANDYMAN_QUOTATION_ISSUED',
    meaning: 'A quotation version was issued and awaits customer decision.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_QUOTATION_ISSUED',
  },
  {
    eventType: 'HANDYMAN_QUOTATION_SUPERSEDED',
    meaning: 'A quotation version was superseded by a newer version.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_QUOTATION_SUPERSEDED',
  },
  {
    eventType: 'HANDYMAN_QUOTATION_EXPIRED',
    meaning: 'A quotation expired without a customer decision.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_QUOTATION_EXPIRED',
  },
  {
    eventType: 'HANDYMAN_PERMIT_READINESS_CREATED',
    meaning: 'Permit/access readiness was recorded for scheduled work.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_PERMIT_READINESS_CREATED',
  },
  {
    eventType: 'HANDYMAN_SCHEDULING_READINESS_CREATED',
    meaning: 'Scheduling readiness was recorded for an execution scope.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_SCHEDULING_READINESS_CREATED',
  },
  {
    eventType: 'HANDYMAN_UNIT_ACCESS_READINESS_CREATED',
    meaning: 'Unit access readiness was recorded for an execution scope.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_UNIT_ACCESS_READINESS_CREATED',
  },
  {
    eventType: 'HANDYMAN_CREW_LEAD_DESIGNATED',
    meaning: 'A crew lead was designated for a work crew.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_CREW_LEAD_DESIGNATED',
  },
  {
    eventType: 'HANDYMAN_CREW_MEMBER_ADDED',
    meaning: 'A member was added to a work crew.',
    audience: 'SUBSCRIPTION_RULE',
    templateKey: 'HANDYMAN_CREW_MEMBER_ADDED',
  },
] as const;

export type HandymanNotificationContractEntry =
  (typeof HANDYMAN_NOTIFICATION_CONTRACT)[number];

export type HandymanNotificationEventType = HandymanNotificationContractEntry['eventType'];

/** Recipient authority kinds frozen by this contract. */
export type HandymanNotificationAudience = 'SUBSCRIPTION_RULE' | 'SLA_ESCALATION_POLICY';

export function isHandymanNotificationEventType(
  value: string,
): value is HandymanNotificationEventType {
  return (HANDYMAN_NOTIFICATION_CONTRACT as readonly { eventType: string }[])
    .some((entry) => entry.eventType === value);
}

/** The frozen contract entry for one admitted event type (undefined when not admitted). */
export function handymanNotificationContractFor(
  eventType: string,
): HandymanNotificationContractEntry | undefined {
  return (HANDYMAN_NOTIFICATION_CONTRACT as readonly HandymanNotificationContractEntry[])
    .find((entry) => entry.eventType === eventType);
}

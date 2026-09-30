/**
 * CR-HM-15 PART 04 — CHARGEABLE ADDITIONAL-WORK SEPARATION types ONLY
 * (FROZEN `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6/§7, §8 row 04, blocker
 * B8).
 *
 * This is a SEPARATE record family — never the free warranty rework:
 *   CHARGEABLE_PROPOSED --ACCEPT--> CHARGEABLE_AUTHORIZED
 *   CHARGEABLE_PROPOSED --REJECT--> CHARGEABLE_REJECTED
 * Both outcomes are final. The customer decision is the ONLY authority;
 * a chargeable referral binds to the APPROVED or REJECTED claim and,
 * through it, to the service warranty and its ORIGINAL execution scope /
 * BAST.
 *
 * Acceptance emits the separation fact + the CR-HM-13 payment trigger
 * fact and NOTHING ELSE: no amount, no price, no currency, no ledger, no
 * payment, no settlement, no entitlement, no FM/SaaS coupling and no
 * warranty-head mutation.
 */

export const HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES = [
  'CHARGEABLE_PROPOSED',
  'CHARGEABLE_AUTHORIZED',
  'CHARGEABLE_REJECTED',
] as const;

export type HandymanChargeableAdditionalWorkStatus =
  (typeof HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES)[number];

export function isHandymanChargeableAdditionalWorkStatus(
  value: string,
): value is HandymanChargeableAdditionalWorkStatus {
  return (HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_STATUSES as readonly string[])
    .includes(value);
}

/** Frozen chargeable event vocabulary (PART 04). */
export const HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_EVENT_TYPES = [
  'PROPOSE',
  'ACCEPT',
  'REJECT',
  'PAYMENT_TRIGGER',
] as const;

export type HandymanChargeableAdditionalWorkEventType =
  (typeof HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_EVENT_TYPES)[number];

export function isHandymanChargeableAdditionalWorkEventType(
  value: string,
): value is HandymanChargeableAdditionalWorkEventType {
  return (HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_EVENT_TYPES as readonly string[])
    .includes(value);
}

/** PART 04 customer decisions (guards, not APIs). */
export const HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ACTIONS = [
  'ACCEPT',
  'REJECT',
] as const;

export type HandymanChargeableAdditionalWorkAction =
  (typeof HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ACTIONS)[number];

export function isHandymanChargeableAdditionalWorkAction(
  value: string,
): value is HandymanChargeableAdditionalWorkAction {
  return (HANDYMAN_CHARGEABLE_ADDITIONAL_WORK_ACTIONS as readonly string[])
    .includes(value);
}

export type HandymanChargeableAdditionalWorkRecord = {
  id: string;
  clientId: string;
  warrantyId: string;
  claimId: string;
  executionScopeId: string;
  bastId: string;
  status: HandymanChargeableAdditionalWorkStatus;
  scopeNote: string;
  proposedByUserId: string;
  proposedAt: Date;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  /** CR-HM-13 separation fact: set IF AND ONLY IF the customer accepted. */
  paymentTriggerEmittedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanChargeableAdditionalWorkEventRecord = {
  id: string;
  clientId: string;
  workId: string;
  claimId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  eventType: HandymanChargeableAdditionalWorkEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: Date;
  createdAt: Date;
};

export type NewHandymanChargeableAdditionalWork = {
  claimId: string;
  scopeNote: string;
  proposedByUserId: string;
};

export type NewHandymanChargeableAdditionalWorkEvent = {
  clientId: string;
  workId: string;
  claimId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  eventType: HandymanChargeableAdditionalWorkEventType;
  idempotencyKey: string;
  actorUserId: string;
};

export type ProposeHandymanChargeableAdditionalWorkInput = {
  claimId: string;
  idempotencyKey: string;
  scopeNote?: string | null;
};

export type HandymanChargeableAdditionalWorkDecisionInput = {
  workId: string;
  idempotencyKey: string;
};

export type HandymanChargeableAdditionalWorkCommandResult = {
  work: HandymanChargeableAdditionalWorkRecord;
  event: HandymanChargeableAdditionalWorkEventRecord;
  /** The CR-HM-13 payment trigger fact, emitted on acceptance only. */
  paymentTrigger: HandymanChargeableAdditionalWorkEventRecord | null;
  warrantyStatus: string;
  claimStatus: string;
  replayed: boolean;
};

/**
 * The outbound seam fact for CR-HM-13: an authorized chargeable scope
 * exists. CR-HM-13 owns pricing, ledger, payment and settlement; this
 * fact carries NO amount and never becomes payment truth here.
 */
export type HandymanChargeablePaymentTriggerFact = {
  workId: string;
  clientId: string;
  claimId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  eventId: string;
  emittedAt: Date;
};

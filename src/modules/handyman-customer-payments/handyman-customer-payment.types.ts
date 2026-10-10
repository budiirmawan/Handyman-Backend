/**
 * CR-HM-13 PART 03 — provider-neutral payment types (FROZEN
 * governance `CR-HM-13_START_GOVERNANCE.md` §5/§8/§9, §10 row 03,
 * §13 row 03).
 *
 * The vocabulary is deliberately NEUTRAL: a closed set of payment
 * rails, bounded free-text provider/reference strings, and a
 * three-state lifecycle whose authority lives in the ledger alone.
 * There is no provider enum, no provider-hosted object, no gateway
 * status, and no settlement vocabulary anywhere in this module.
 *
 * Money crosses this boundary as a canonical decimal STRING
 * (`NNN.NN`, at most 2 decimals): no JavaScript float arithmetic ever
 * touches an amount (§4.7 / I7).
 */

/** The CLOSED neutral channel vocabulary — rails, never providers. */
export const HANDYMAN_CUSTOMER_PAYMENT_CHANNELS = [
  'CASH',
  'BANK_TRANSFER',
  'VIRTUAL_ACCOUNT',
  'QRIS',
  'CARD',
  'OTHER',
] as const;

export type HandymanCustomerPaymentChannel =
  (typeof HANDYMAN_CUSTOMER_PAYMENT_CHANNELS)[number];

export function isHandymanCustomerPaymentChannel(
  value: string,
): value is HandymanCustomerPaymentChannel {
  return (HANDYMAN_CUSTOMER_PAYMENT_CHANNELS as readonly string[])
    .includes(value);
}

/**
 * Payment lifecycle: `PENDING` (a recorded claim — NOT authoritative
 * received funds), `CONFIRMED` (the authoritative received-funds fact,
 * reachable only through the bounded server-side confirmation path),
 * `REJECTED` (bounded terminal outcome of an unconfirmable claim).
 * NOTIFICATION IS NEVER AUTHORITY (§5.3).
 */
export const HANDYMAN_CUSTOMER_PAYMENT_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'REJECTED',
] as const;

export type HandymanCustomerPaymentStatus =
  (typeof HANDYMAN_CUSTOMER_PAYMENT_STATUSES)[number];

export function isHandymanCustomerPaymentStatus(
  value: string,
): value is HandymanCustomerPaymentStatus {
  return (HANDYMAN_CUSTOMER_PAYMENT_STATUSES as readonly string[])
    .includes(value);
}

export const HANDYMAN_CUSTOMER_PAYMENT_EVENT_TYPES = [
  'RECORD_PAYMENT',
  'CONFIRM_PAYMENT',
  'REJECT_PAYMENT',
] as const;

export type HandymanCustomerPaymentEventType =
  (typeof HANDYMAN_CUSTOMER_PAYMENT_EVENT_TYPES)[number];

export function isHandymanCustomerPaymentEventType(
  value: string,
): value is HandymanCustomerPaymentEventType {
  return (HANDYMAN_CUSTOMER_PAYMENT_EVENT_TYPES as readonly string[])
    .includes(value);
}

/**
 * The payment fact row. Money/identity fields are frozen once
 * recorded; only the one-way decision projection may change
 * (`PENDING` -> `CONFIRMED` | `REJECTED`).
 */
export type HandymanCustomerPaymentRecord = {
  id: string;
  clientId: string;
  transactionId: string;
  status: HandymanCustomerPaymentStatus;
  /** NUMERIC(18,2) canonical decimal string; always > 0. */
  amount: string;
  currency: string;
  channel: HandymanCustomerPaymentChannel;
  /** Bounded free text (<= 200 chars) — never a provider enum. */
  providerName: string | null;
  /** Bounded free text (<= 200 chars) — never a provider object. */
  providerReference: string | null;
  /** Unique per transaction where present (§5.5). */
  externalReference: string | null;
  /** DB-server clock at record time; callers never pass a time. */
  receivedAt: string;
  /** Reporter identity namespace. Exactly one of the two identities is set. */
  recordedByActorType: HandymanPaymentActorType;
  recordedByUserId: string | null;
  recordedByCareActorId: string | null;
  recordedByWorkspaceSessionId: string | null;
  decidedAt: string | null;
  decidedByUserId: string | null;
  rejectionReason: string | null;
  createdAt: string;
};

export type HandymanCustomerPaymentEventRecord = {
  id: string;
  clientId: string;
  paymentId: string;
  transactionId: string;
  eventType: HandymanCustomerPaymentEventType;
  idempotencyKey: string;
  actorType: HandymanPaymentActorType;
  actorUserId: string | null;
  actorCareActorId: string | null;
  actorWorkspaceSessionId: string | null;
  occurredAt: string;
  createdAt: string;
};

/* ---- Actor identity (auditable, never interchangeable) ----------- */

export type HandymanPaymentActorType = 'USER' | 'CARE_ACTOR';

/**
 * The identity that performed a payment action. A User is the existing
 * authority (record/verify via RBAC). A Customer Care actor reports ONLY
 * through a live workspace session and can never verify (schema-enforced
 * allowlist + no decision path accepts this shape).
 */
export type HandymanPaymentActorRef =
  | { actorType: 'USER'; userId: string }
  | {
      actorType: 'CARE_ACTOR';
      careActorId: string;
      workspaceSessionId: string;
    };

/** Caller-side recorder: a bare User id (existing) or a verified care actor. */
export type HandymanPaymentRecorder =
  | string
  | {
      kind: 'CARE_ACTOR';
      careActorId: string;
      workspaceSessionId: string;
      /** Building of the request the workspace projected; must match scope. */
      requestBuildingId: string;
    };

/* ---- Persistence inputs (server-derived fields ONLY) ------------ */

export type NewHandymanCustomerPayment = {
  clientId: string;
  transactionId: string;
  amount: string;
  currency: string;
  channel: HandymanCustomerPaymentChannel;
  providerName: string | null;
  providerReference: string | null;
  externalReference: string | null;
  recordedBy: HandymanPaymentActorRef;
};

export type NewHandymanCustomerPaymentEvent = {
  clientId: string;
  paymentId: string;
  transactionId: string;
  eventType: HandymanCustomerPaymentEventType;
  idempotencyKey: string;
  actor: HandymanPaymentActorRef;
};

/* ---- Caller inputs ----------------------------------------------- */

/**
 * RECORD_PAYMENT input. The amount IS caller-supplied — it is an
 * external fact (funds received), not a derived figure — but it is
 * validated, never trusted: currency must be the transaction's own
 * (no FX), the amount must be a canonical positive decimal, and the
 * recorded payment is NOT authoritative until confirmed. Status,
 * decided-at/by, received-at, transaction and client are NOT accepted
 * from the caller (smuggled keys are structurally ignored).
 */
export type RecordHandymanCustomerPaymentInput = {
  executionScopeId: string;
  amount: string;
  channel: string;
  providerName?: string | null;
  providerReference?: string | null;
  externalReference?: string | null;
  idempotencyKey: string;
};

/** CONFIRM/REJECT input: references + bounded reason only. */
export type ConfirmHandymanCustomerPaymentInput = {
  executionScopeId: string;
  paymentId: string;
  idempotencyKey: string;
};

export type RejectHandymanCustomerPaymentInput =
  ConfirmHandymanCustomerPaymentInput & {
    reason: string;
  };

export type HandymanCustomerPaymentCommandResult = {
  payment: HandymanCustomerPaymentRecord;
  event: HandymanCustomerPaymentEventRecord;
  replayed: boolean;
};

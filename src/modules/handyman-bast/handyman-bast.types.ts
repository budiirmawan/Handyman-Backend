/**
 * CR-HM-11 PART 01 — Handyman BAST aggregate types ONLY (FROZEN
 * `CR-HM-11_START_GOVERNANCE.md` §3–§8). Status vocabulary is the
 * full frozen set. PART 01 events: PREPARE/ISSUE/VOID.
 * PART 02 events: ACCEPT/REJECT (state-gated sign-off).
 * Sign-off rows are evidence, never a second status authority.
 * NO payment, NO warranty, NO FM BAST FK.
 */

export const HANDYMAN_BAST_STATUSES = [
  'DRAFT',
  'ISSUED',
  'ACCEPTED',
  'REJECTED',
  'VOID',
] as const;

export type HandymanBastStatus =
  (typeof HANDYMAN_BAST_STATUSES)[number];

export function isHandymanBastStatus(
  value: string,
): value is HandymanBastStatus {
  return (HANDYMAN_BAST_STATUSES as readonly string[]).includes(value);
}

/** PART 01 write actions. */
export const HANDYMAN_BAST_PART01_EVENT_TYPES = [
  'PREPARE',
  'ISSUE',
  'VOID',
] as const;

export type HandymanBastPart01EventType =
  (typeof HANDYMAN_BAST_PART01_EVENT_TYPES)[number];

export function isHandymanBastPart01EventType(
  value: string,
): value is HandymanBastPart01EventType {
  return (HANDYMAN_BAST_PART01_EVENT_TYPES as readonly string[])
    .includes(value);
}

/** PART 02 customer sign-off actions. */
export const HANDYMAN_BAST_PART02_EVENT_TYPES = [
  'ACCEPT',
  'REJECT',
] as const;

export type HandymanBastPart02EventType =
  (typeof HANDYMAN_BAST_PART02_EVENT_TYPES)[number];

export const HANDYMAN_BAST_EVENT_TYPES = [
  ...HANDYMAN_BAST_PART01_EVENT_TYPES,
  ...HANDYMAN_BAST_PART02_EVENT_TYPES,
] as const;

export type HandymanBastEventType =
  (typeof HANDYMAN_BAST_EVENT_TYPES)[number];

export function isHandymanBastEventType(
  value: string,
): value is HandymanBastEventType {
  return (HANDYMAN_BAST_EVENT_TYPES as readonly string[]).includes(value);
}

export type HandymanBastRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  status: HandymanBastStatus;
  issuedAt: Date | null;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  voidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NewHandymanBast = {
  clientId: string;
  executionScopeId: string;
};

export type HandymanBastEventRecord = {
  id: string;
  clientId: string;
  bastId: string;
  executionScopeId: string;
  eventType: HandymanBastEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: Date;
  createdAt: Date;
};

export type NewHandymanBastEvent = {
  clientId: string;
  bastId: string;
  executionScopeId: string;
  eventType: HandymanBastEventType;
  idempotencyKey: string;
  actorUserId: string;
};

export type HandymanBastSignOffRecord = {
  id: string;
  clientId: string;
  bastId: string;
  eventId: string;
  executionScopeId: string;
  decision: HandymanBastPart02EventType;
  signatureDigest: string;
  evidenceRecordId: string | null;
  rejectReason: string | null;
  createdAt: Date;
};

export type NewHandymanBastSignOff = {
  clientId: string;
  bastId: string;
  eventId: string;
  executionScopeId: string;
  decision: HandymanBastPart02EventType;
  signatureDigest: string;
  evidenceRecordId: string | null;
  rejectReason: string | null;
};

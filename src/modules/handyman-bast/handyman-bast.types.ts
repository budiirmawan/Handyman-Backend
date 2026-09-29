/**
 * CR-HM-11 PART 01 — Handyman BAST aggregate types ONLY (FROZEN
 * `CR-HM-11_START_GOVERNANCE.md` §3–§8). Status vocabulary is the
 * full frozen set. PART 01 event types are PREPARE/ISSUE/VOID only.
 * ACCEPT/REJECT are reserved for PART 02 (not implemented here).
 * NO signature, NO payment, NO warranty, NO FM BAST FK.
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

/** PART 01 write actions. ACCEPT/REJECT are not in this set. */
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

export type HandymanBastRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  status: HandymanBastStatus;
  issuedAt: Date | null;
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
  eventType: HandymanBastPart01EventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: Date;
  createdAt: Date;
};

export type NewHandymanBastEvent = {
  clientId: string;
  bastId: string;
  executionScopeId: string;
  eventType: HandymanBastPart01EventType;
  idempotencyKey: string;
  actorUserId: string;
};

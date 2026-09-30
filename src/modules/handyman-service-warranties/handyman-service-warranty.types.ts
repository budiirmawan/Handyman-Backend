/**
 * CR-HM-15 PART 01 — Handyman SERVICE WARRANTY aggregate types ONLY
 * (FROZEN `CR-HM-15_START_GOVERNANCE.md` §3/§4/§5/§5.1).
 *
 * Status vocabulary is the full frozen set. PART 01 persists ONLY
 * `ACTIVE` (start) and `EXPIRED` (explicit expiry fact): the
 * claim/rework values stay reserved for PART 02+ exactly as CR-HM-11
 * PART 01 reserved ACCEPT/REJECT. `INELIGIBLE` means "not started" — it
 * is EVALUATED from the BAST, never authored, and therefore never
 * persisted.
 *
 * NO claim intake, NO rework execution, NO chargeable additional-work
 * separation, NO payment/ledger, NO pricing, NO FM asset warranty.
 */

export const HANDYMAN_SERVICE_WARRANTY_STATUSES = [
  'INELIGIBLE',
  'ACTIVE',
  'CLAIM_OPEN',
  'CLAIM_APPROVED',
  'CLAIM_REJECTED',
  'REWORK_IN_PROGRESS',
  'REWORK_COMPLETE',
  'EXPIRED',
] as const;

export type HandymanServiceWarrantyStatus =
  (typeof HANDYMAN_SERVICE_WARRANTY_STATUSES)[number];

export function isHandymanServiceWarrantyStatus(
  value: string,
): value is HandymanServiceWarrantyStatus {
  return (HANDYMAN_SERVICE_WARRANTY_STATUSES as readonly string[])
    .includes(value);
}

/** PART 01 write authority: start + explicit expiry ONLY. */
export const HANDYMAN_SERVICE_WARRANTY_PART01_STATUSES = [
  'ACTIVE',
  'EXPIRED',
] as const;

export type HandymanServiceWarrantyPart01Status =
  (typeof HANDYMAN_SERVICE_WARRANTY_PART01_STATUSES)[number];

/**
 * Warranty coverage vocabulary (frozen §5): the two service-warranty
 * kinds stay SEPARATE and are never collapsed into one undifferentiated
 * coverage. Neither is FM's asset warranty.
 */
export const HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES = [
  'WORKMANSHIP',
  'MATERIAL',
] as const;

export type HandymanServiceWarrantyCoverageType =
  (typeof HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES)[number];

export function isHandymanServiceWarrantyCoverageType(
  value: string,
): value is HandymanServiceWarrantyCoverageType {
  return (HANDYMAN_SERVICE_WARRANTY_COVERAGE_TYPES as readonly string[])
    .includes(value);
}

/** PART 01 event vocabulary. */
export const HANDYMAN_SERVICE_WARRANTY_EVENT_TYPES = [
  'START',
  'EXPIRE',
] as const;

export type HandymanServiceWarrantyEventType =
  (typeof HANDYMAN_SERVICE_WARRANTY_EVENT_TYPES)[number];

export function isHandymanServiceWarrantyEventType(
  value: string,
): value is HandymanServiceWarrantyEventType {
  return (HANDYMAN_SERVICE_WARRANTY_EVENT_TYPES as readonly string[])
    .includes(value);
}

export type HandymanServiceWarrantyRecord = {
  id: string;
  clientId: string;
  executionScopeId: string;
  bastId: string;
  bastAcceptedAt: Date;
  status: HandymanServiceWarrantyStatus;
  startsAt: Date;
  expiredAt: Date | null;
  startedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Insert shape of the head row. The client, execution scope, acceptance
 * instant and start boundary are NEVER supplied by a caller: they are
 * derived in SQL from the ACCEPTED BAST row itself.
 */
export type NewHandymanServiceWarranty = {
  bastId: string;
  startedByUserId: string;
};

export type HandymanServiceWarrantyCoverageRecord = {
  id: string;
  clientId: string;
  warrantyId: string;
  executionScopeId: string;
  coverageType: HandymanServiceWarrantyCoverageType;
  createdAt: Date;
};

export type NewHandymanServiceWarrantyCoverage = {
  clientId: string;
  warrantyId: string;
  executionScopeId: string;
  coverageType: HandymanServiceWarrantyCoverageType;
};

export type HandymanServiceWarrantyEventRecord = {
  id: string;
  clientId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  eventType: HandymanServiceWarrantyEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: Date;
  createdAt: Date;
};

export type NewHandymanServiceWarrantyEvent = {
  clientId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  eventType: HandymanServiceWarrantyEventType;
  idempotencyKey: string;
  actorUserId: string;
};

export type StartHandymanServiceWarrantyInput = {
  executionScopeId: string;
  idempotencyKey: string;
};

export type ExpireHandymanServiceWarrantyInput = {
  warrantyId: string;
  idempotencyKey: string;
};

export type HandymanServiceWarrantyCommandResult = {
  warranty: HandymanServiceWarrantyRecord;
  coverages: HandymanServiceWarrantyCoverageRecord[];
  event: HandymanServiceWarrantyEventRecord;
  replayed: boolean;
};

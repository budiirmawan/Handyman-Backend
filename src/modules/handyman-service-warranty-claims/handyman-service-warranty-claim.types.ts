/**
 * CR-HM-15 PART 02 — Handyman SERVICE WARRANTY CLAIM types ONLY
 * (FROZEN `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6, §8 row 02).
 *
 * The claim record lifecycle is the FROZEN claim vocabulary:
 *   CLAIM_DRAFT -> CLAIM_SUBMITTED -> CLAIM_APPROVED | CLAIM_REJECTED |
 *   CLAIM_WITHDRAWN
 * where the warranty HEAD mirrors it as ACTIVE (draft/withdrawn),
 * CLAIM_OPEN (submitted), CLAIM_APPROVED and CLAIM_REJECTED.
 *
 * Rework states (REWORK_*) are NOT part of this PART and not part of the
 * claim record vocabulary.
 *
 * NO pricing/payment/settlement/ledger, NO chargeable separation,
 * NO FM asset warranty or SaaS coupling.
 */

import type { HandymanServiceWarrantyStatus }
  from '../handyman-service-warranties';

export const HANDYMAN_SERVICE_WARRANTY_CLAIM_STATUSES = [
  'CLAIM_DRAFT',
  'CLAIM_SUBMITTED',
  'CLAIM_APPROVED',
  'CLAIM_REJECTED',
  'CLAIM_WITHDRAWN',
] as const;

export type HandymanServiceWarrantyClaimStatus =
  (typeof HANDYMAN_SERVICE_WARRANTY_CLAIM_STATUSES)[number];

export function isHandymanServiceWarrantyClaimStatus(
  value: string,
): value is HandymanServiceWarrantyClaimStatus {
  return (HANDYMAN_SERVICE_WARRANTY_CLAIM_STATUSES as readonly string[])
    .includes(value);
}

/** Frozen claim event vocabulary (PART 02). */
export const HANDYMAN_SERVICE_WARRANTY_CLAIM_EVENT_TYPES = [
  'OPEN',
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'WITHDRAW',
] as const;

export type HandymanServiceWarrantyClaimEventType =
  (typeof HANDYMAN_SERVICE_WARRANTY_CLAIM_EVENT_TYPES)[number];

export function isHandymanServiceWarrantyClaimEventType(
  value: string,
): value is HandymanServiceWarrantyClaimEventType {
  return (HANDYMAN_SERVICE_WARRANTY_CLAIM_EVENT_TYPES as readonly string[])
    .includes(value);
}

/** PART 02 actions (guards, not APIs). */
export const HANDYMAN_SERVICE_WARRANTY_CLAIM_ACTIONS = [
  'SUBMIT',
  'APPROVE',
  'REJECT',
  'WITHDRAW',
] as const;

export type HandymanServiceWarrantyClaimAction =
  (typeof HANDYMAN_SERVICE_WARRANTY_CLAIM_ACTIONS)[number];

export function isHandymanServiceWarrantyClaimAction(
  value: string,
): value is HandymanServiceWarrantyClaimAction {
  return (HANDYMAN_SERVICE_WARRANTY_CLAIM_ACTIONS as readonly string[])
    .includes(value);
}

export type HandymanServiceWarrantyClaimRecord = {
  id: string;
  clientId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  status: HandymanServiceWarrantyClaimStatus;
  claimNote: string;
  evidenceRecordId: string | null;
  openedByUserId: string;
  submittedAt: Date | null;
  claimantUserId: string | null;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  decisionNote: string | null;
  withdrawnAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Insert shape. Client, execution scope and BAST are read FROM the parent
 * warranty row in SQL: no caller-supplied identity is ever authority.
 */
export type NewHandymanServiceWarrantyClaim = {
  warrantyId: string;
  claimNote: string;
  evidenceRecordId: string | null;
  openedByUserId: string;
};

export type HandymanServiceWarrantyClaimEventRecord = {
  id: string;
  clientId: string;
  claimId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  eventType: HandymanServiceWarrantyClaimEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: Date;
  createdAt: Date;
};

export type NewHandymanServiceWarrantyClaimEvent = {
  clientId: string;
  claimId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  eventType: HandymanServiceWarrantyClaimEventType;
  idempotencyKey: string;
  actorUserId: string;
};

export type OpenHandymanServiceWarrantyClaimInput = {
  warrantyId: string;
  idempotencyKey: string;
  claimNote?: string | null;
  evidenceRecordId?: string | null;
};

export type SubmitHandymanServiceWarrantyClaimInput = {
  claimId: string;
  idempotencyKey: string;
  evidenceRecordId?: string | null;
};

export type DecideHandymanServiceWarrantyClaimInput = {
  claimId: string;
  idempotencyKey: string;
  decisionNote?: string | null;
};

export type WithdrawHandymanServiceWarrantyClaimInput = {
  claimId: string;
  idempotencyKey: string;
};

export type HandymanServiceWarrantyClaimCommandResult = {
  claim: HandymanServiceWarrantyClaimRecord;
  event: HandymanServiceWarrantyClaimEventRecord;
  /** Warranty head after the claim transition (unchanged when DRAFT). */
  warrantyStatus: HandymanServiceWarrantyStatus;
  replayed: boolean;
};

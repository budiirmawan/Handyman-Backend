/**
 * CR-HM-15 PART 03 — FREE WARRANTY REWORK types ONLY (FROZEN
 * `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6/§7, §8 row 03).
 *
 * Free rework lifecycle (warranty only):
 *   REWORK_DRAFT -> REWORK_AUTHORIZED -> REWORK_IN_PROGRESS ->
 *   REWORK_COMPLETE -> REWORK_VERIFIED
 * It exists ONLY for an APPROVED claim, and chargeable additional work is
 * a SEPARATE concern (PART 04) that never shares this record.
 *
 * The verification pass closes the claim: `REWORK_VERIFIED` on this
 * record IS the closure, because the claim record's frozen vocabulary has
 * no separate "closed" value and the warranty head's frozen vocabulary
 * has no post-verification state.
 *
 * NO pricing/payment/settlement/ledger, NO chargeable separation, NO FM
 * asset warranty or SaaS coupling.
 */

export const HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES = [
  'REWORK_DRAFT',
  'REWORK_AUTHORIZED',
  'REWORK_IN_PROGRESS',
  'REWORK_COMPLETE',
  'REWORK_VERIFIED',
] as const;

export type HandymanServiceWarrantyReworkStatus =
  (typeof HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES)[number];

export function isHandymanServiceWarrantyReworkStatus(
  value: string,
): value is HandymanServiceWarrantyReworkStatus {
  return (HANDYMAN_SERVICE_WARRANTY_REWORK_STATUSES as readonly string[])
    .includes(value);
}

/** Frozen free-rework event vocabulary (PART 03). */
export const HANDYMAN_SERVICE_WARRANTY_REWORK_EVENT_TYPES = [
  'PROPOSE',
  'ACCEPT',
  'START',
  'COMPLETE',
  'VERIFY',
] as const;

export type HandymanServiceWarrantyReworkEventType =
  (typeof HANDYMAN_SERVICE_WARRANTY_REWORK_EVENT_TYPES)[number];

export function isHandymanServiceWarrantyReworkEventType(
  value: string,
): value is HandymanServiceWarrantyReworkEventType {
  return (HANDYMAN_SERVICE_WARRANTY_REWORK_EVENT_TYPES as readonly string[])
    .includes(value);
}

/** PART 03 actions (guards, not APIs). */
export const HANDYMAN_SERVICE_WARRANTY_REWORK_ACTIONS = [
  'ACCEPT',
  'START',
  'COMPLETE',
  'VERIFY',
] as const;

export type HandymanServiceWarrantyReworkAction =
  (typeof HANDYMAN_SERVICE_WARRANTY_REWORK_ACTIONS)[number];

export function isHandymanServiceWarrantyReworkAction(
  value: string,
): value is HandymanServiceWarrantyReworkAction {
  return (HANDYMAN_SERVICE_WARRANTY_REWORK_ACTIONS as readonly string[])
    .includes(value);
}

export type HandymanServiceWarrantyReworkRecord = {
  id: string;
  clientId: string;
  warrantyId: string;
  claimId: string;
  executionScopeId: string;
  bastId: string;
  status: HandymanServiceWarrantyReworkStatus;
  scopeNote: string;
  proposedByUserId: string;
  proposedAt: Date;
  authorizedAt: Date | null;
  authorizedByUserId: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  completionNote: string | null;
  verifiedAt: Date | null;
  verifiedByUserId: string | null;
  verificationEvidenceRecordId: string | null;
  verificationQcRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Insert shape. Client, warranty, execution scope and BAST are read FROM
 * the approved CLAIM row in SQL: no caller-supplied identity is ever
 * authority.
 */
export type NewHandymanServiceWarrantyRework = {
  claimId: string;
  scopeNote: string;
  proposedByUserId: string;
};

export type HandymanServiceWarrantyReworkEventRecord = {
  id: string;
  clientId: string;
  reworkId: string;
  claimId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  eventType: HandymanServiceWarrantyReworkEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: Date;
  createdAt: Date;
};

export type NewHandymanServiceWarrantyReworkEvent = {
  clientId: string;
  reworkId: string;
  claimId: string;
  warrantyId: string;
  executionScopeId: string;
  bastId: string;
  eventType: HandymanServiceWarrantyReworkEventType;
  idempotencyKey: string;
  actorUserId: string;
};

export type ProposeHandymanServiceWarrantyReworkInput = {
  claimId: string;
  idempotencyKey: string;
  scopeNote?: string | null;
};

export type HandymanServiceWarrantyReworkTransitionInput = {
  reworkId: string;
  idempotencyKey: string;
};

export type CompleteHandymanServiceWarrantyReworkInput = {
  reworkId: string;
  idempotencyKey: string;
  completionNote?: string | null;
};

export type VerifyHandymanServiceWarrantyReworkInput = {
  reworkId: string;
  idempotencyKey: string;
  evidenceRecordId: string;
  qcRunId?: string | null;
};

export type HandymanServiceWarrantyReworkCommandResult = {
  rework: HandymanServiceWarrantyReworkRecord;
  event: HandymanServiceWarrantyReworkEventRecord;
  /** Warranty head after the rework transition. */
  warrantyStatus: import('../handyman-service-warranties')
    .HandymanServiceWarrantyStatus;
  claimStatus: import('../handyman-service-warranty-claims')
    .HandymanServiceWarrantyClaimStatus;
  replayed: boolean;
};

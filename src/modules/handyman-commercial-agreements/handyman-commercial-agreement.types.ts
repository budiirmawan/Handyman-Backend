/**
 * CR-HM-12 PART 01 — Handyman commercial agreement aggregate types
 * ONLY (FROZEN `CR-HM-12_START_GOVERNANCE.md` §5). One agreement per
 * client; versions bounded to DRAFT | ACTIVE | SUPERSEDED with an
 * [effectiveFrom, effectiveTo) window. Events: PREPARE/ACTIVATE/
 * SUPERSEDE only — pricing modes (PART 02), material basis (PART 03)
 * and BM fee rules (PART 04) bind to the exact version id later.
 * ZERO amount/price/rate/fee/currency/charge facts exist here.
 */

export const HANDYMAN_COMMERCIAL_AGREEMENT_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'SUPERSEDED',
] as const;

export type HandymanCommercialAgreementStatus =
  (typeof HANDYMAN_COMMERCIAL_AGREEMENT_STATUSES)[number];

export function isHandymanCommercialAgreementStatus(
  value: string,
): value is HandymanCommercialAgreementStatus {
  return (
    HANDYMAN_COMMERCIAL_AGREEMENT_STATUSES as readonly string[]
  ).includes(value);
}

export const HANDYMAN_COMMERCIAL_AGREEMENT_EVENT_TYPES = [
  'PREPARE',
  'ACTIVATE',
  'SUPERSEDE',
] as const;

export type HandymanCommercialAgreementEventType =
  (typeof HANDYMAN_COMMERCIAL_AGREEMENT_EVENT_TYPES)[number];

export function isHandymanCommercialAgreementEventType(
  value: string,
): value is HandymanCommercialAgreementEventType {
  return (
    HANDYMAN_COMMERCIAL_AGREEMENT_EVENT_TYPES as readonly string[]
  ).includes(value);
}

export type HandymanCommercialAgreementRecord = {
  id: string;
  clientId: string;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanCommercialAgreementVersionRecord = {
  id: string;
  agreementId: string;
  clientId: string;
  versionNumber: number;
  status: HandymanCommercialAgreementStatus;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type HandymanCommercialAgreementEventRecord = {
  id: string;
  clientId: string;
  agreementId: string;
  versionId: string;
  eventType: HandymanCommercialAgreementEventType;
  idempotencyKey: string;
  actorUserId: string;
  occurredAt: Date;
  createdAt: Date;
};

export type NewHandymanCommercialAgreement = {
  clientId: string;
  createdByUserId: string;
};

export type NewHandymanCommercialAgreementVersion = {
  agreementId: string;
  versionNumber: number;
  createdByUserId: string;
};

export type NewHandymanCommercialAgreementEvent = {
  clientId: string;
  agreementId: string;
  versionId: string;
  eventType: HandymanCommercialAgreementEventType;
  idempotencyKey: string;
  actorUserId: string;
};

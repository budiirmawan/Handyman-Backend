/**
 * CR-HM-11 PART 03 — published BAST/acceptance READ contract for
 * CR-HM-15 / CR-HM-17 / CR-HM-18. Projects PART 01–02 authority
 * only. NOT a second write path. NOT warranty runtime. NOT ledger.
 * NOT FM BAST. Session COMPLETE / quotation approval / QC PASS are
 * never mapped to customer acceptance.
 */

import type {
  HandymanBastRecord,
  HandymanBastStatus,
} from './handyman-bast.types';

/** Frozen aliases that MUST NOT be treated as BAST Acceptance. */
export const HANDYMAN_NOT_BAST_ACCEPTANCE = [
  'SESSION_COMPLETE',
  'CHECK_OUT',
  'QUOTATION_APPROVAL',
  'QC_PASS',
  'FM_BAST_STATUS',
] as const;

export type HandymanNotBastAcceptance =
  (typeof HANDYMAN_NOT_BAST_ACCEPTANCE)[number];

/**
 * Bounded public read shape. `status` is the sole acceptance
 * authority (sign-off rows are evidence, never truth).
 */
export type HandymanBastAcceptanceReadContract = {
  bastId: string;
  clientId: string;
  executionScopeId: string;
  status: HandymanBastStatus;
  customerAccepted: boolean;
  warrantyStartEligible: boolean;
  issuedAt: Date | null;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  voidedAt: Date | null;
};

export function isHandymanCustomerBastAccepted(
  status: HandymanBastStatus,
): boolean {
  return status === 'ACCEPTED';
}

/** CR-HM-15 may start service warranty ONLY from ACCEPTED. */
export function isHandymanWarrantyStartEligible(
  status: HandymanBastStatus,
): boolean {
  return status === 'ACCEPTED';
}

export function isNotBastAcceptanceAlias(
  value: string,
): value is HandymanNotBastAcceptance {
  return (HANDYMAN_NOT_BAST_ACCEPTANCE as readonly string[])
    .includes(value);
}

export function toHandymanBastAcceptanceReadContract(
  bast: HandymanBastRecord,
): HandymanBastAcceptanceReadContract {
  const customerAccepted = isHandymanCustomerBastAccepted(bast.status);
  return {
    bastId: bast.id,
    clientId: bast.clientId,
    executionScopeId: bast.executionScopeId,
    status: bast.status,
    customerAccepted,
    warrantyStartEligible: isHandymanWarrantyStartEligible(bast.status),
    issuedAt: bast.issuedAt,
    acceptedAt: customerAccepted ? bast.acceptedAt : null,
    rejectedAt: bast.status === 'REJECTED' ? bast.rejectedAt : null,
    voidedAt: bast.status === 'VOID' ? bast.voidedAt : null,
  };
}

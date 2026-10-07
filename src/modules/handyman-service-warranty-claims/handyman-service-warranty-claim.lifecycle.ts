/**
 * CR-HM-15 PART 02 — service-warranty CLAIM lifecycle guards
 * (FROZEN `CR-HM-15_START_GOVERNANCE.md` §4/§5/§7/§8, §8 row 02).
 *
 * TWO machines, one authority each:
 *
 * 1. The CLAIM record machine —
 *      CLAIM_DRAFT --SUBMIT--> CLAIM_SUBMITTED
 *      CLAIM_SUBMITTED --APPROVE|REJECT|WITHDRAW--> terminal
 *    A terminal claim never moves again (one authoritative transition).
 *
 * 2. The warrant HEAD machine for the claim path — the head mirrors the
 *    claim, because the warranty status column is the single
 *    authoritative warranty state (§5):
 *      ACTIVE --SUBMIT--> CLAIM_OPEN
 *      CLAIM_OPEN --APPROVE--> CLAIM_APPROVED
 *      CLAIM_OPEN --REJECT--> CLAIM_REJECTED
 *      CLAIM_OPEN --WITHDRAW--> ACTIVE (withdrawn claims leave the
 *      warranty active; the head vocabulary has no CLAIM_WITHDRAWN)
 *    PART 01 owns START/EXPIRE; this file owns the claim-path head moves
 *    and never touches PART 01's START/EXPIRE authority.
 *
 * Never a claim trigger/decision source (§4): session COMPLETE,
 * CHECK_OUT, QC PASS, quotation approval and FM asset-warranty state.
 */

import { HANDYMAN_NOT_SERVICE_WARRANTY_START }
  from '../handyman-service-warranties';
import type { HandymanServiceWarrantyStatus }
  from '../handyman-service-warranties';
import {
  handymanServiceWarrantyClaimIllegalTransitionError,
  handymanServiceWarrantyClaimNotEligibleError,
} from './handyman-service-warranty-claim.errors';
import type {
  HandymanServiceWarrantyClaimStatus,
} from './handyman-service-warranty-claim.types';

/**
 * The same frozen negatives that can never start a warranty can never
 * trigger or decide a warranty claim: a crew COMPLETE, a QC PASS, a
 * quotation approval or FM asset-warranty state is never a claim fact.
 */
export const HANDYMAN_NOT_WARRANTY_CLAIM_TRIGGER =
  HANDYMAN_NOT_SERVICE_WARRANTY_START;

export type HandymanNotWarrantyClaimTrigger =
  (typeof HANDYMAN_NOT_WARRANTY_CLAIM_TRIGGER)[number];

export function isNotWarrantyClaimTriggerAlias(
  value: string,
): value is HandymanNotWarrantyClaimTrigger {
  return (HANDYMAN_NOT_WARRANTY_CLAIM_TRIGGER as readonly string[])
    .includes(value);
}

/**
 * Intake eligibility (§4): a claim binds to an EXISTING service warranty
 * that is `ACTIVE` on its ORIGINAL execution scope. A warranty that is
 * expired, or already in a claim/rework state, accepts no new claim.
 */
export function assertHandymanServiceWarrantyClaimIntakeEligible(
  warrantyStatus: HandymanServiceWarrantyStatus,
): void {
  if (warrantyStatus !== 'ACTIVE') {
    throw handymanServiceWarrantyClaimNotEligibleError(
      `warranty-status=${warrantyStatus}`,
    );
  }
}

/** The claim record machine (PART 02). */
export function nextHandymanServiceWarrantyClaimStatus(
  from: HandymanServiceWarrantyClaimStatus,
  action: string,
): HandymanServiceWarrantyClaimStatus {
  if (action === 'SUBMIT' && from === 'CLAIM_DRAFT') {
    return 'CLAIM_SUBMITTED';
  }
  if (from === 'CLAIM_SUBMITTED') {
    if (action === 'APPROVE') return 'CLAIM_APPROVED';
    if (action === 'REJECT') return 'CLAIM_REJECTED';
    if (action === 'WITHDRAW') return 'CLAIM_WITHDRAWN';
  }
  throw handymanServiceWarrantyClaimIllegalTransitionError(from, action);
}

/** The warranty HEAD machine for the claim path (PART 02). */
export function nextHandymanServiceWarrantyClaimHeadStatus(
  from: HandymanServiceWarrantyStatus,
  action: string,
): HandymanServiceWarrantyStatus {
  if (action === 'SUBMIT' && from === 'ACTIVE') {
    return 'CLAIM_OPEN';
  }
  if (from === 'CLAIM_OPEN') {
    if (action === 'APPROVE') return 'CLAIM_APPROVED';
    if (action === 'REJECT') return 'CLAIM_REJECTED';
    if (action === 'WITHDRAW') return 'ACTIVE';
  }
  throw handymanServiceWarrantyClaimIllegalTransitionError(from, action);
}

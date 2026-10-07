/**
 * CR-HM-15 PART 03 — free-warranty-REWORK lifecycle guards (FROZEN
 * `CR-HM-15_START_GOVERNANCE.md` §4/§5/§7, §8 row 03).
 *
 * TWO machines, one authority each:
 *
 * 1. The REWORK record machine —
 *      REWORK_DRAFT --ACCEPT--> REWORK_AUTHORIZED --START-->
 *      REWORK_IN_PROGRESS --COMPLETE--> REWORK_COMPLETE --VERIFY-->
 *      REWORK_VERIFIED
 *    PROPOSE creates the record (no transition); VERIFIED is terminal and
 *    closes the claim. There is NO chargeable state in this machine:
 *    chargeable additional work stays SEPARATE (PART 04, §7/B8).
 *
 * 2. The warranty HEAD machine for the rework path — the head mirrors the
 *    free rework because it owns the single authoritative warranty status
 *    (§5):
 *      CLAIM_APPROVED --START--> REWORK_IN_PROGRESS
 *      REWORK_IN_PROGRESS --COMPLETE--> REWORK_COMPLETE
 *      REWORK_COMPLETE --VERIFY--> REWORK_COMPLETE (still: the frozen
 *      head vocabulary has no post-verification state; the claim closure
 *      is recorded on the rework record)
 *      CLAIM_APPROVED --PROPOSE|ACCEPT--> CLAIM_APPROVED (unchanged)
 *    PART 01 owns START/EXPIRE, PART 02 owns the claim path; this file
 *    owns the rework-path head moves only.
 */

import type { HandymanServiceWarrantyClaimStatus }
  from '../handyman-service-warranty-claims';
import type { HandymanServiceWarrantyStatus }
  from '../handyman-service-warranties';
import {
  handymanServiceWarrantyReworkIllegalTransitionError,
  handymanServiceWarrantyReworkNotEligibleError,
} from './handyman-service-warranty-rework.errors';
import type { HandymanServiceWarrantyReworkStatus }
  from './handyman-service-warranty-rework.types';

/**
 * The frozen negatives: crew COMPLETE, CHECK_OUT, QC PASS, quotation
 * approval and FM asset-warranty state never propose, authorize, start,
 * complete or verify a free rework — and QC PASS in particular is only
 * ever a READ-ONLY verification input, never a rework trigger.
 */
export const HANDYMAN_NOT_WARRANTY_REWORK_AUTHORITY = [
  'SESSION_COMPLETE',
  'CHECK_OUT',
  'QUOTATION_APPROVAL',
  'QC_PASS',
  'FM_ASSET_WARRANTY_STATUS',
  'ASSET_WARRANTY',
] as const;

export type HandymanNotWarrantyReworkAuthority =
  (typeof HANDYMAN_NOT_WARRANTY_REWORK_AUTHORITY)[number];

export function isNotWarrantyReworkAuthorityAlias(
  value: string,
): value is HandymanNotWarrantyReworkAuthority {
  return (HANDYMAN_NOT_WARRANTY_REWORK_AUTHORITY as readonly string[])
    .includes(value);
}

/**
 * Intake gate (§4/§5): free rework requires an APPROVED claim on a
 * warranty whose head is CLAIM_APPROVED (claim approved; free rework
 * authorized). A submitted, withdrawn, rejected or not-yet-decided claim
 * never gets free rework, and neither does a rework-advanced warranty.
 */
export function assertHandymanServiceWarrantyReworkIntakeEligible(
  claimStatus: HandymanServiceWarrantyClaimStatus,
  warrantyStatus: HandymanServiceWarrantyStatus,
): void {
  if (claimStatus !== 'CLAIM_APPROVED') {
    throw handymanServiceWarrantyReworkNotEligibleError(
      `claim-status=${claimStatus}`,
    );
  }
  if (warrantyStatus !== 'CLAIM_APPROVED') {
    throw handymanServiceWarrantyReworkNotEligibleError(
      `warranty-status=${warrantyStatus}`,
    );
  }
}

/** The free-rework record machine (PART 03). */
export function nextHandymanServiceWarrantyReworkStatus(
  from: HandymanServiceWarrantyReworkStatus,
  action: string,
): HandymanServiceWarrantyReworkStatus {
  if (from === 'REWORK_DRAFT' && action === 'ACCEPT') {
    return 'REWORK_AUTHORIZED';
  }
  if (from === 'REWORK_AUTHORIZED' && action === 'START') {
    return 'REWORK_IN_PROGRESS';
  }
  if (from === 'REWORK_IN_PROGRESS' && action === 'COMPLETE') {
    return 'REWORK_COMPLETE';
  }
  if (from === 'REWORK_COMPLETE' && action === 'VERIFY') {
    return 'REWORK_VERIFIED';
  }
  throw handymanServiceWarrantyReworkIllegalTransitionError(from, action);
}

/** The warranty HEAD machine for the rework path (PART 03). */
export function nextHandymanServiceWarrantyReworkHeadStatus(
  from: HandymanServiceWarrantyStatus,
  action: string,
): HandymanServiceWarrantyStatus {
  if ((action === 'PROPOSE' || action === 'ACCEPT') && from === 'CLAIM_APPROVED') {
    return 'CLAIM_APPROVED';
  }
  if (action === 'START' && from === 'CLAIM_APPROVED') {
    return 'REWORK_IN_PROGRESS';
  }
  if (action === 'COMPLETE' && from === 'REWORK_IN_PROGRESS') {
    return 'REWORK_COMPLETE';
  }
  if (action === 'VERIFY' && from === 'REWORK_COMPLETE') {
    return 'REWORK_COMPLETE';
  }
  throw handymanServiceWarrantyReworkIllegalTransitionError(from, action);
}

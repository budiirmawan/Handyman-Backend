/**
 * CR-HM-15 PART 04 — chargeable-additional-work lifecycle guards (FROZEN
 * `CR-HM-15_START_GOVERNANCE.md` §4/§5/§6/§7, §8 row 04, blocker B8).
 *
 * ONE machine lives here — the SEPARATED chargeable record:
 *
 *   CHARGEABLE_PROPOSED --ACCEPT--> CHARGEABLE_AUTHORIZED
 *   CHARGEABLE_PROPOSED --REJECT--> CHARGEABLE_REJECTED
 *
 * PROPOSE creates the record (no transition); both outcomes are final.
 * There is NO free-rework state in this machine and no chargeable state
 * in the free-rework machine: the two paths are mutually exclusive per
 * claim (§7/B8).
 *
 * The warranty HEAD is NOT moved by this PART. The frozen head vocabulary
 * (§5) has no chargeable value, the head owns warranty truth only, and
 * financial execution stays downstream (CR-HM-13): accepting a chargeable
 * scope emits a separation fact + payment trigger fact and nothing else.
 */

import type { HandymanServiceWarrantyClaimStatus }
  from '../handyman-service-warranty-claims';
import type { HandymanServiceWarrantyReworkStatus }
  from '../handyman-service-warranty-reworks';
import type { HandymanServiceWarrantyStatus }
  from '../handyman-service-warranties';
import {
  handymanChargeableAdditionalWorkFreeReworkConflictError,
  handymanChargeableAdditionalWorkIllegalTransitionError,
  handymanChargeableAdditionalWorkNotEligibleError,
} from './handyman-chargeable-additional-work.errors';
import type { HandymanChargeableAdditionalWorkStatus }
  from './handyman-chargeable-additional-work.types';

/**
 * The frozen negatives (mirrors §4/§5/§7): crew COMPLETE, CHECK_OUT,
 * QC PASS, quotation approval and FM asset-warranty state never propose,
 * authorize or reject chargeable additional work. QC PASS stays a
 * READ-ONLY input elsewhere; it is never a chargeable trigger.
 */
export const HANDYMAN_NOT_CHARGEABLE_ADDITIONAL_WORK_AUTHORITY = [
  'SESSION_COMPLETE',
  'CHECK_OUT',
  'QUOTATION_APPROVAL',
  'QC_PASS',
  'FM_ASSET_WARRANTY_STATUS',
  'ASSET_WARRANTY',
] as const;

export type HandymanNotChargeableAdditionalWorkAuthority =
  (typeof HANDYMAN_NOT_CHARGEABLE_ADDITIONAL_WORK_AUTHORITY)[number];

export function isNotChargeableAdditionalWorkAuthorityAlias(
  value: string,
): value is HandymanNotChargeableAdditionalWorkAuthority {
  return (HANDYMAN_NOT_CHARGEABLE_ADDITIONAL_WORK_AUTHORITY as readonly
    string[]).includes(value);
}

/** The two head states in which the chargeable path is available. */
const CHARGEABLE_CLAIM_STATUSES: readonly HandymanServiceWarrantyClaimStatus[] =
  ['CLAIM_APPROVED', 'CLAIM_REJECTED'];

/**
 * Intake gate (§4/§5): the chargeable path is available for an APPROVED
 * claim (free scope not taken) or a REJECTED claim, and the warranty head
 * must agree with the claim — the head owns warranty truth. A draft,
 * submitted or withdrawn claim has no chargeable path, and an
 * already-started/complete/expired warranty has none either.
 */
export function assertHandymanChargeableAdditionalWorkIntakeEligible(
  claimStatus: HandymanServiceWarrantyClaimStatus,
  warrantyStatus: HandymanServiceWarrantyStatus,
): void {
  if (!CHARGEABLE_CLAIM_STATUSES.includes(claimStatus)) {
    throw handymanChargeableAdditionalWorkNotEligibleError(
      `claim-status=${claimStatus}`,
    );
  }
  if (warrantyStatus !== claimStatus) {
    throw handymanChargeableAdditionalWorkNotEligibleError(
      `warranty-status=${warrantyStatus}`,
    );
  }
}

/**
 * BLOCKER B8 — the separation law at the referral gate: a chargeable
 * referral can only be created while the claim's free rework is absent
 * (no free rework was proposed) or still REWORK_DRAFT (proposed but never
 * accepted). An authorized, in-progress, completed or verified free
 * rework can NEVER be converted into chargeable additional work.
 */
export function assertHandymanChargeableAdditionalWorkFreeReworkSeparated(
  freeReworkStatus: HandymanServiceWarrantyReworkStatus | null,
): void {
  if (freeReworkStatus === null || freeReworkStatus === 'REWORK_DRAFT') {
    return;
  }
  throw handymanChargeableAdditionalWorkFreeReworkConflictError(
    `free-rework-status=${freeReworkStatus}`,
  );
}

/** The separated chargeable record machine (PART 04). */
export function nextHandymanChargeableAdditionalWorkStatus(
  from: HandymanChargeableAdditionalWorkStatus,
  action: string,
): HandymanChargeableAdditionalWorkStatus {
  if (from === 'CHARGEABLE_PROPOSED' && action === 'ACCEPT') {
    return 'CHARGEABLE_AUTHORIZED';
  }
  if (from === 'CHARGEABLE_PROPOSED' && action === 'REJECT') {
    return 'CHARGEABLE_REJECTED';
  }
  throw handymanChargeableAdditionalWorkIllegalTransitionError(from, action);
}

/**
 * The warranty HEAD machine for this PART: every chargeable action leaves
 * the head EXACTLY where it is (CLAIM_APPROVED or CLAIM_REJECTED, matched
 * by the intake gate). A chargeable decision is never a warranty state and
 * never a money state — financial execution belongs to CR-HM-13.
 */
export function nextHandymanChargeableAdditionalWorkHeadStatus(
  from: HandymanServiceWarrantyStatus,
  action: string,
): HandymanServiceWarrantyStatus {
  if (action !== 'PROPOSE' && action !== 'ACCEPT' && action !== 'REJECT') {
    throw handymanChargeableAdditionalWorkIllegalTransitionError(from, action);
  }
  if (from !== 'CLAIM_APPROVED' && from !== 'CLAIM_REJECTED') {
    throw handymanChargeableAdditionalWorkIllegalTransitionError(from, action);
  }
  return from;
}

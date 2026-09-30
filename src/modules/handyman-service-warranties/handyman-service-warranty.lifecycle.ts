/**
 * CR-HM-15 PART 01 — service-warranty eligibility + status guards
 * (FROZEN `CR-HM-15_START_GOVERNANCE.md` §5, §5.1, §7 B1–B3).
 *
 * Eligibility is DERIVED, never authored: the ONLY source that may start
 * a Handyman service warranty is a customer-ACCEPTED BAST (CR-HM-11).
 * Session COMPLETE / CHECK_OUT (CR-HM-08), quotation approval (CR-HM-06),
 * QC PASS (CR-HM-10) and FM asset-warranty state are structurally
 * incapable of starting a warranty here.
 *
 * PART 01 status machine (the claim/rework values stay reserved for
 * PART 02+):
 *   INELIGIBLE --START--> ACTIVE --EXPIRE--> EXPIRED
 */

import {
  isHandymanWarrantyStartEligible,
  type HandymanBastStatus,
} from '../handyman-bast';
import {
  handymanServiceWarrantyIllegalTransitionError,
  handymanServiceWarrantyNotEligibleError,
} from './handyman-service-warranty.errors';
import type {
  HandymanServiceWarrantyEventType,
  HandymanServiceWarrantyStatus,
} from './handyman-service-warranty.types';

/**
 * The ONE frozen warranty-start source. Anything else is not a source.
 */
export const HANDYMAN_SERVICE_WARRANTY_START_SOURCES = [
  'ACCEPTED_BAST',
] as const;

export type HandymanServiceWarrantyStartSource =
  (typeof HANDYMAN_SERVICE_WARRANTY_START_SOURCES)[number];

/**
 * Frozen aliases that MUST NEVER start a service warranty. Consumed as
 * negative vocabulary so no future PART can quietly graft one of them
 * onto the start gate.
 */
export const HANDYMAN_NOT_SERVICE_WARRANTY_START = [
  'SESSION_COMPLETE',
  'CHECK_OUT',
  'QUOTATION_APPROVAL',
  'QC_PASS',
  'FM_ASSET_WARRANTY_STATUS',
  'ASSET_WARRANTY',
] as const;

export type HandymanNotServiceWarrantyStart =
  (typeof HANDYMAN_NOT_SERVICE_WARRANTY_START)[number];

export function isNotServiceWarrantyStartAlias(
  value: string,
): value is HandymanNotServiceWarrantyStart {
  return (HANDYMAN_NOT_SERVICE_WARRANTY_START as readonly string[])
    .includes(value);
}

/**
 * Evaluates the warranty start gate for a BAST status. `ELIGIBLE` means
 * "an ACCEPTED BAST exists for this scope"; `INELIGIBLE` is the
 * "not started" derived state (§5) and is never persisted.
 */
export function evaluateHandymanServiceWarrantyEligibility(
  bastStatus: HandymanBastStatus,
): 'ELIGIBLE' | 'INELIGIBLE' {
  return isHandymanWarrantyStartEligible(bastStatus)
    ? 'ELIGIBLE'
    : 'INELIGIBLE';
}

/** Fail-closed start gate (governance §5.1 — the sole eligibility law). */
export function assertHandymanServiceWarrantyStartEligible(
  bastStatus: HandymanBastStatus,
): void {
  if (!isHandymanWarrantyStartEligible(bastStatus)) {
    throw handymanServiceWarrantyNotEligibleError(
      `bast-status=${bastStatus}`,
    );
  }
}

/**
 * The ONLY status authority. START is legal solely from the derived
 * INELIGIBLE state; EXPIRE is legal solely from ACTIVE in PART 01.
 * Claim/rework transitions do not exist yet (PART 02+) and every unknown
 * action is refused.
 */
export function nextHandymanServiceWarrantyStatus(
  from: HandymanServiceWarrantyStatus,
  action: string,
): HandymanServiceWarrantyStatus {
  if (action === 'START') {
    if (from !== 'INELIGIBLE') {
      throw handymanServiceWarrantyIllegalTransitionError(from, action);
    }
    return 'ACTIVE';
  }
  if (action === 'EXPIRE') {
    if (from !== 'ACTIVE') {
      throw handymanServiceWarrantyIllegalTransitionError(from, action);
    }
    return 'EXPIRED';
  }
  throw handymanServiceWarrantyIllegalTransitionError(from, action);
}

export function isHandymanServiceWarrantyPart01Action(
  action: string,
): action is HandymanServiceWarrantyEventType {
  return action === 'START' || action === 'EXPIRE';
}

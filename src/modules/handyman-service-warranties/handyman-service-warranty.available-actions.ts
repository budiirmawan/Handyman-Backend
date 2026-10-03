/**
 * CR-HM-17 P1 FIX02 — B7 warranty/claim/rework/chargeable-work
 * availableActions read projection.
 *
 * Derives Customer Care actions from the frozen CR-HM-15 lifecycle
 * and tenant_company.manage authority. Zero new lifecycle rules.
 * Commands remain in existing authority.
 *
 * Customer Care (BM Super App) represents BM-side authority for:
 *   - Claims: APPROVE / REJECT when submitted; WITHDRAW when draft.
 *   - Free Reworks: AUTHORIZE when proposed (DRAFT).
 *   - Chargeable Works: (customer decisions ACCEPT/REJECT — NOT BM;
 *     Customer Care sees them as no-action from BM perspective).
 */

import type { HandymanServiceWarrantyClaimStatus }
  from '../handyman-service-warranty-claims';
import type { HandymanServiceWarrantyReworkStatus }
  from '../handyman-service-warranty-reworks';
import type { HandymanChargeableAdditionalWorkStatus }
  from '../handyman-chargeable-additional-works';

/* ---- B7a: Claim available actions ---------------------------------- */

export type HandymanServiceWarrantyClaimAvailableAction =
  | 'APPROVE'
  | 'REJECT'
  | 'WITHDRAW';

export function computeClaimAvailableActions(
  status: HandymanServiceWarrantyClaimStatus,
): readonly HandymanServiceWarrantyClaimAvailableAction[] {
  switch (status) {
    case 'CLAIM_DRAFT':
      return ['WITHDRAW'] as const;
    case 'CLAIM_SUBMITTED':
      return ['APPROVE', 'REJECT', 'WITHDRAW'] as const;
    default:
      return [] as const;
  }
}

/* ---- B7b: Free rework available actions ---------------------------- */

export type HandymanServiceWarrantyReworkAvailableAction = 'AUTHORIZE';

export function computeReworkAvailableActions(
  status: HandymanServiceWarrantyReworkStatus,
): readonly HandymanServiceWarrantyReworkAvailableAction[] {
  if (status === 'REWORK_DRAFT') {
    return ['AUTHORIZE'] as const;
  }
  return [] as const;
}

/* ---- B7c: Chargeable additional work available actions ------------- */

/**
 * Customer Care (BM) has NO actions on chargeable additional works.
 * The customer alone decides ACCEPT/REJECT. BM only reads.
 */
export type HandymanChargeableAdditionalWorkAvailableAction = never;

export function computeChargeableWorkAvailableActions(
  _status: HandymanChargeableAdditionalWorkStatus,
): readonly HandymanChargeableAdditionalWorkAvailableAction[] {
  return [] as const;
}

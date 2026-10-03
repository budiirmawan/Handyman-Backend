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
 *   - Chargeable Works: ACCEPT / REJECT when PROPOSED (customer decision).
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
 * Customer Care (BM Super App) executes customer decisions on behalf of
 * the customer. ACCEPT/REJECT are available when the work is PROPOSED.
 */
export type HandymanChargeableAdditionalWorkAvailableAction =
  | 'ACCEPT'
  | 'REJECT';

export function computeChargeableWorkAvailableActions(
  status: HandymanChargeableAdditionalWorkStatus,
): readonly HandymanChargeableAdditionalWorkAvailableAction[] {
  if (status === 'CHARGEABLE_PROPOSED') {
    return ['ACCEPT', 'REJECT'] as const;
  }
  return [] as const;
}

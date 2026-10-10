/**
 * CR-HM-17 P1 FIX02 — B6 payment availableActions read projection.
 *
 * Derives Customer Care actions from the frozen CR-HM-13 payment
 * lifecycle and tenant_company.manage authority. Zero new lifecycle
 * rules. Commands remain in existing authority.
 *
 * Customer Care (BM Super App) can CONFIRM or REJECT a payment
 * when its status is PENDING. No actions in terminal statuses.
 */

import type { HandymanCustomerPaymentStatus }
  from './handyman-customer-payment.types';

/**
 * Payment decision actions available to Customer Care.
 * Derived solely from payment status; authorization (canAccessClient,
 * tenant_company.manage) is the caller's wall.
 */
export type HandymanCustomerPaymentAvailableAction =
  | 'CONFIRM'
  | 'REJECT';

/**
 * PART 04: CONFIRM/REJECT are verification actions. They are offered ONLY
 * when the viewer holds the explicit `handyman.payment.verify` permission
 * AND is not the recorder of this payment (maker-checker). Default is
 * fail-closed: no verification action is offered without `canVerify`.
 * Reporting (RECORD) is never an available action of a payment.
 */
export function computePaymentAvailableActions(
  status: HandymanCustomerPaymentStatus,
  canVerify: boolean = false,
): readonly HandymanCustomerPaymentAvailableAction[] {
  if (status === 'PENDING' && canVerify) {
    return ['CONFIRM', 'REJECT'] as const;
  }
  return [] as const;
}

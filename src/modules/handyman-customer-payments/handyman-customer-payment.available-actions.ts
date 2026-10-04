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

export function computePaymentAvailableActions(
  status: HandymanCustomerPaymentStatus,
): readonly HandymanCustomerPaymentAvailableAction[] {
  if (status === 'PENDING') {
    return ['CONFIRM', 'REJECT'] as const;
  }
  return [] as const;
}

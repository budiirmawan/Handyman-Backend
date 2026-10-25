/** Status PLUS explicit Handyman Finance authority. Care reports/evidence
 * are not permission to confirm received funds; default projection is closed.
 * Owning payment commands still recheck live Finance + exact Building access. */
import type { HandymanCustomerPaymentStatus }
  from './handyman-customer-payment.types';

/** This projection never grants authority; terminal facts have no actions. */
export type HandymanCustomerPaymentAvailableAction =
  | 'CONFIRM'
  | 'REJECT';

export function computePaymentAvailableActions(
  status: HandymanCustomerPaymentStatus,
  canVerify = false,
): readonly HandymanCustomerPaymentAvailableAction[] {
  if (canVerify && status === 'PENDING') {
    return ['CONFIRM', 'REJECT'] as const;
  }
  return [] as const;
}

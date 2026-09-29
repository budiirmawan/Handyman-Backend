/**
 * CR-HM-13 PART 03 — provider-neutral payment authority exports
 * (FROZEN governance `CR-HM-13_START_GOVERNANCE.md` §5/§9, §13 row 03).
 *
 * Bounded surface: record a payment claim (`PENDING`), and the
 * bounded server-side confirmation path that makes it the
 * authoritative received-funds fact (`CONFIRMED`) or the bounded
 * terminal outcome (`REJECTED`), with append-only lifecycle
 * evidence and single-use idempotency. Payments are always the
 * TRANSACTION'S OWN currency (no FX) and carry only neutral channels
 * plus bounded free-text references.
 *
 * Still NO allocation (PART 04), NO refund / reversal / adjustment
 * (PART 05), NO published read contract (PART 06), NO HTTP, NO
 * OpenAPI, NO named-provider/gateway vocabulary or adapter, NO
 * entitlement, settlement, or payout.
 */

export {
  recordHandymanCustomerPayment,
  confirmHandymanCustomerPayment,
  rejectHandymanCustomerPayment,
  listHandymanCustomerPayments,
} from './handyman-customer-payment.service';

export { handymanCustomerPaymentRepository }
  from './handyman-customer-payment.repository';

export {
  handymanCustomerPaymentNotFoundError,
  handymanCustomerPaymentConflictError,
  handymanCustomerPaymentInvalidError,
} from './handyman-customer-payment.errors';

export {
  HANDYMAN_CUSTOMER_PAYMENT_CHANNELS,
  isHandymanCustomerPaymentChannel,
  HANDYMAN_CUSTOMER_PAYMENT_STATUSES,
  isHandymanCustomerPaymentStatus,
  HANDYMAN_CUSTOMER_PAYMENT_EVENT_TYPES,
  isHandymanCustomerPaymentEventType,
} from './handyman-customer-payment.types';

export type {
  HandymanCustomerPaymentChannel,
  HandymanCustomerPaymentStatus,
  HandymanCustomerPaymentEventType,
  HandymanCustomerPaymentRecord,
  HandymanCustomerPaymentEventRecord,
  NewHandymanCustomerPayment,
  NewHandymanCustomerPaymentEvent,
  RecordHandymanCustomerPaymentInput,
  ConfirmHandymanCustomerPaymentInput,
  RejectHandymanCustomerPaymentInput,
  HandymanCustomerPaymentCommandResult,
} from './handyman-customer-payment.types';

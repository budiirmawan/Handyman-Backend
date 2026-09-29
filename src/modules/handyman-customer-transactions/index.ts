/**
 * CR-HM-13 PART 01 — customer transaction + charge-line FOUNDATION
 * exports (FROZEN governance `CR-HM-13_START_GOVERNANCE.md` §3/§4/§9,
 * §13 row 01).
 *
 * Bounded surface: the transaction anchor (exactly one per CR-HM-06
 * Execution Scope), immutable charge lines whose commercial facts come
 * from the immutable quotation snapshot, and the append-only event
 * stream with single-use idempotency. NO charge composition (PART 02),
 * NO payment / allocation (PART 03/04), NO refund / reversal /
 * adjustment (PART 05), NO published read contract (PART 06), NO HTTP,
 * NO OpenAPI, NO provider/gateway vocabulary, NO entitlement or
 * settlement.
 */

export {
  openHandymanCustomerTransaction,
  postHandymanChargeLine,
} from './handyman-customer-transaction.service';

export { handymanCustomerTransactionRepository }
  from './handyman-customer-transaction.repository';

export {
  handymanCustomerTransactionNotFoundError,
  handymanCustomerTransactionScopeNotFoundError,
  handymanCustomerTransactionNotAuthorizedError,
  handymanCustomerTransactionBasisInvalidError,
  handymanCustomerTransactionConflictError,
  handymanCustomerTransactionValidationError,
} from './handyman-customer-transaction.errors';

export {
  HANDYMAN_CUSTOMER_TRANSACTION_EVENT_TYPES,
  isHandymanCustomerTransactionEventType,
} from './handyman-customer-transaction.types';

export type {
  HandymanChargeLineKind,
  HandymanChargeLineRecord,
  HandymanCustomerTransactionCurrency,
  HandymanCustomerTransactionEventRecord,
  HandymanCustomerTransactionEventType,
  HandymanCustomerTransactionRecord,
  NewHandymanChargeLine,
  NewHandymanCustomerTransaction,
  NewHandymanCustomerTransactionEvent,
  OpenHandymanCustomerTransactionInput,
  PostHandymanChargeLineInput,
  HandymanCustomerTransactionCommandResult,
  HandymanChargeLineCommandResult,
} from './handyman-customer-transaction.types';

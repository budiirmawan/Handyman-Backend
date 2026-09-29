/**
 * CR-HM-13 PART 01/02 — customer transaction + charge-line FOUNDATION
 * and COMPOSITION exports (FROZEN governance
 * `CR-HM-13_START_GOVERNANCE.md` §3/§4/§9, §13 rows 01–02).
 *
 * Bounded surface: the transaction anchor (exactly one per CR-HM-06
 * Execution Scope), immutable charge lines COMPOSED from governed
 * read-only inputs with their immutable composition anchors, and the
 * append-only event stream with single-use idempotency. Still NO
 * payment / allocation (PART 03/04), NO refund / reversal /
 * adjustment (PART 05), NO published read contract (PART 06), NO HTTP,
 * NO OpenAPI, NO provider/gateway vocabulary, NO entitlement or
 * settlement.
 */

export {
  openHandymanCustomerTransaction,
  composeHandymanChargeLine,
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
  HANDYMAN_CHARGE_COMPOSITION_KINDS,
  isHandymanChargeCompositionKind,
  HANDYMAN_CHARGE_BASIS_FACT_KINDS,
  isHandymanChargeBasisFactKind,
} from './handyman-customer-transaction.types';

export type {
  HandymanChargeBasisFactKind,
  HandymanChargeCompositionKind,
  HandymanChargeLineBasisRecord,
  HandymanChargeLineKind,
  HandymanChargeLineRecord,
  HandymanCustomerTransactionCurrency,
  HandymanCustomerTransactionEventRecord,
  HandymanCustomerTransactionEventType,
  HandymanCustomerTransactionRecord,
  NewHandymanChargeLine,
  NewHandymanChargeLineBasis,
  NewHandymanCustomerTransaction,
  NewHandymanCustomerTransactionEvent,
  OpenHandymanCustomerTransactionInput,
  PostHandymanChargeLineInput,
  ComposeHandymanChargeLineInput,
  HandymanCustomerTransactionCommandResult,
  HandymanChargeLineCommandResult,
} from './handyman-customer-transaction.types';

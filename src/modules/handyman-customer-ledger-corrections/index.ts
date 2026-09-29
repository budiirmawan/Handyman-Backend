/**
 * CR-HM-13 PART 05 — refund / reversal / adjustment exports (FROZEN
 * governance `CR-HM-13_START_GOVERNANCE.md` §7/§9, §13 row 05).
 *
 * Bounded surface: append forward-only correction facts against the
 * immutable ledger (refund a confirmed payment up to what was received
 * and applied, reverse ONE specific fact exactly once, adjust a charge
 * line or the transaction by a bounded reasoned delta), plus a bounded
 * facts read and a DERIVED net view for downstream consumers.
 *
 * History is never rewritten: no command here updates or deletes a
 * prior fact, and no correction ever touches CR-HM-06/09/11.
 *
 * Still NO published read contract (PART 06), NO HTTP, NO OpenAPI, NO
 * entitlement/settlement/payout, NO named-provider/gateway runtime.
 */

export {
  refundHandymanCustomerPayment,
  reverseHandymanPaymentAllocation,
  reverseHandymanCustomerPayment,
  adjustHandymanCustomerLedger,
  listHandymanLedgerCorrections,
  summarizeHandymanLedgerCorrections,
} from './handyman-ledger-correction.service';

export { handymanLedgerCorrectionRepository }
  from './handyman-ledger-correction.repository';

export {
  handymanLedgerCorrectionNotFoundError,
  handymanLedgerCorrectionConflictError,
  handymanLedgerCorrectionInvalidError,
} from './handyman-ledger-correction.errors';

export {
  HANDYMAN_LEDGER_CORRECTION_KINDS,
  isHandymanLedgerCorrectionKind,
  HANDYMAN_LEDGER_CORRECTION_SOURCE_KINDS,
  isHandymanLedgerCorrectionSourceKind,
} from './handyman-ledger-correction.types';

export type {
  HandymanLedgerCorrectionKind,
  HandymanLedgerCorrectionSourceKind,
  HandymanLedgerCorrectionRecord,
  NewHandymanLedgerCorrection,
  RefundHandymanCustomerPaymentInput,
  ReverseHandymanAllocationInput,
  ReverseHandymanPaymentInput,
  AdjustHandymanCustomerLedgerInput,
  HandymanLedgerCorrectionCommandResult,
  HandymanLedgerCorrectionSummary,
} from './handyman-ledger-correction.types';

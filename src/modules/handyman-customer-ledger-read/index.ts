/**
 * CR-HM-13 PART 06 — PUBLISHED READ CONTRACT exports (FROZEN
 * governance `CR-HM-13_START_GOVERNANCE.md` §7.4/§10/§11.8, §13 row
 * 06).
 *
 * Published for CR-HM-14 (entitlement gating) and CR-HM-17/18
 * (presentation): `readHandymanLedgerTransactionAt` (one ledger
 * transaction's facts + gross/net totals) and
 * `readHandymanLedgerClientBasisAt` (windowed per-ledger net basis).
 *
 * Both are READ-ONLY and WRITE-INCAPABLE: they publish facts, never
 * authority — no posting, no allocation, no correction, no refund, no
 * reversal, no adjustment, no settlement, no entitlement derivation,
 * no HTTP, no OpenAPI. Corrections stay machine-visible (all three
 * kinds) and every money figure is published as gross AND net (§7.4),
 * with LABOR/MATERIAL separated (I13) and the explicit
 * `authoritativeForEntitlement` gate.
 */

export {
  readHandymanLedgerTransactionAt,
  readHandymanLedgerClientBasisAt,
} from './handyman-ledger-read.service';

export { handymanLedgerReadRepository }
  from './handyman-ledger-read.repository';

export { handymanLedgerReadInvalidError }
  from './handyman-ledger-read.errors';

export {
  HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
  HANDYMAN_LEDGER_READ_AUTHORITY_DENIALS,
  HANDYMAN_LEDGER_READ_DEFAULT_LIMIT,
  HANDYMAN_LEDGER_READ_MAX_LIMIT,
  isHandymanLedgerReadPaymentAuthoritative,
} from './handyman-ledger-read.types';

export type {
  HandymanLedgerReadAuthority,
  HandymanLedgerReadAuthorityDenial,
  HandymanLedgerReadPayment,
  HandymanLedgerReadChargeLine,
  HandymanLedgerReadAllocation,
  HandymanLedgerReadCorrection,
  HandymanLedgerReadCorrectionCounts,
  HandymanLedgerReadTotals,
  HandymanLedgerTransactionRead,
  HandymanLedgerClientBasisEntry,
  HandymanLedgerClientBasisRead,
  ReadHandymanLedgerClientBasisOptions,
} from './handyman-ledger-read.types';

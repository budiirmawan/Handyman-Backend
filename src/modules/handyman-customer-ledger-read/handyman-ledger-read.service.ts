import {
  canAccessBuildingScopedResource,
  contextAccessService,
} from '../context-access';
import { isValidUuid } from '../clients';
import {
  handymanCustomerTransactionNotAuthorizedError,
  handymanCustomerTransactionNotFoundError,
  handymanCustomerTransactionScopeNotFoundError,
} from '../handyman-customer-transactions';
import { handymanExecutionScopeRepository }
  from '../handyman-quotations';
import { handymanLedgerReadInvalidError }
  from './handyman-ledger-read.errors';
import {
  handymanLedgerReadRepository,
  type RawClientBasisRow,
  type RawLedgerTransactionRead,
} from './handyman-ledger-read.repository';
import {
  HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
  HANDYMAN_LEDGER_READ_DEFAULT_LIMIT,
  HANDYMAN_LEDGER_READ_MAX_LIMIT,
  isHandymanLedgerReadPaymentAuthoritative,
  type HandymanLedgerClientBasisEntry,
  type HandymanLedgerClientBasisRead,
  type HandymanLedgerReadAllocation,
  type HandymanLedgerReadAuthorityDenial,
  type HandymanLedgerReadChargeLine,
  type HandymanLedgerReadCorrection,
  type HandymanLedgerReadCorrectionCounts,
  type HandymanLedgerReadPayment,
  type HandymanLedgerReadTotals,
  type HandymanLedgerTransactionRead,
  type ReadHandymanLedgerClientBasisOptions,
} from './handyman-ledger-read.types';

/**
 * CR-HM-13 PART 06 — published read composition (FROZEN governance
 * `CR-HM-13_START_GOVERNANCE.md` §7.4/§10/§11.8, §13 row 06).
 *
 * READ-ONLY COMPOSITION ONLY. This service:
 *  - reads facts through the single-SELECT repository (no mutation
 *    verb, no transaction handle, no command import — B12);
 *  - publishes BOTH gross (the immutable posted fact) and net (the
 *    correction-netted basis) for every figure, so a consumer can
 *    never be handed a gross-only number (§7.4);
 *  - keeps LABOR and MATERIAL separate at every level (I13);
 *  - derives everything as a projection over facts (I12) and does its
 *    arithmetic in integer cents (I7) — no float touches money;
 *  - gates the result with `authoritativeForEntitlement`, which is
 *    true only for a correction-netted basis over posted facts with no
 *    undecided channel intake outstanding (fail-closed).
 *
 * It derives NO entitlement, NO settlement, NO fee, and writes
 * nothing anywhere.
 */

const LIMIT_MIN = 1;
const ISO_MAX = 40;

/* ---- Exact money arithmetic (integer cents only) ----------------- */

function toCents(value: unknown): bigint {
  const text = typeof value === 'string' ? value : String(value ?? '0');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Exact ISO-8601 with milliseconds — timestamps are facts too (§7.3). */
function toIso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value)))
    .toISOString();
}

/* ---- Input validation (no authority from the caller) ------------- */

function ensureUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw handymanLedgerReadInvalidError(field);
  }
  return value;
}

function ensureWindow(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > ISO_MAX ||
    Number.isNaN(Date.parse(value))
  ) {
    throw handymanLedgerReadInvalidError(field);
  }
  return new Date(value).toISOString();
}

function ensureLimit(value: number | undefined): number {
  if (value === undefined) return HANDYMAN_LEDGER_READ_DEFAULT_LIMIT;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < LIMIT_MIN ||
    value > HANDYMAN_LEDGER_READ_MAX_LIMIT
  ) {
    throw handymanLedgerReadInvalidError('limit');
  }
  return value;
}

/**
 * The CR-HM-13 access wall (same law as every ledger PART): an
 * unknown scope is a bounded 404 (never fabricated) and an actor
 * without access to the scope's exact Building is a bounded 403.
 * Serves ONLY `readHandymanLedgerTransactionAt` — the intentionally
 * client-wide `readHandymanLedgerClientBasisAt` keeps its own
 * client-level wall and is NOT served by this preamble.
 */
async function scopeAuthorityPreamble(
  scopeUuid: string,
  actorUserId: string,
) {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanCustomerTransactionScopeNotFoundError();
  // CR-HM-SEC-01 PART 06G — BE-02G exact-Building check on the
  // authoritative server-derived scope building (migration 0395),
  // replacing the client-level canAccessClient shortcut: a same-Client
  // sibling Building assignment must not read the ledger transaction.
  // The module's denial vocabulary (403
  // HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED) and error precedence
  // (scope 404 precedes the access wall) are unchanged.
  if (!(await canAccessBuildingScopedResource(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  }))) {
    throw handymanCustomerTransactionNotAuthorizedError();
  }
  return scope;
}

/* ---- Composition helpers ---------------------------------------- */

function mapAllocation(row: Record<string, unknown>)
  : HandymanLedgerReadAllocation {
  return {
    allocationId: text(row.allocationId),
    paymentId: text(row.paymentId),
    chargeLineId: text(row.chargeLineId),
    lineKind: text(row.lineKind) as HandymanLedgerReadAllocation['lineKind'],
    currency: text(row.currency) as HandymanLedgerReadAllocation['currency'],
    amount: text(row.amount),
    occurredAt: new Date(text(row.occurredAt)).toISOString(),
    reversed: row.reversed === true,
  };
}

function mapCorrection(row: Record<string, unknown>)
  : HandymanLedgerReadCorrection {
  return {
    correctionId: text(row.correctionId),
    correctionKind: text(row.correctionKind) as HandymanLedgerReadCorrection['correctionKind'],
    sourceKind: text(row.sourceKind) as HandymanLedgerReadCorrection['sourceKind'],
    sourcePaymentId: nullableText(row.sourcePaymentId),
    sourceAllocationId: nullableText(row.sourceAllocationId),
    sourceChargeLineId: nullableText(row.sourceChargeLineId),
    currency: text(row.currency) as HandymanLedgerReadCorrection['currency'],
    amount: text(row.amount),
    reason: text(row.reason),
    correctedByUserId: text(row.correctedByUserId),
    occurredAt: new Date(text(row.occurredAt)).toISOString(),
  };
}

/* ---- Published read 1: one ledger transaction ------------------- */

/**
 * The full read-only composition of ONE ledger transaction, anchored
 * by its Execution Scope: facts (charge lines, payments, allocations,
 * corrections), gross + net totals, and the authority gate.
 */
export async function readHandymanLedgerTransactionAt(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanLedgerTransactionRead> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await scopeAuthorityPreamble(scopeUuid, actorUuid);

  const raw = await handymanLedgerReadRepository
    .readTransactionByScope(scopeUuid);
  if (!raw.transaction) throw handymanCustomerTransactionNotFoundError();
  return composeTransactionRead(raw);
}

function composeTransactionRead(
  raw: RawLedgerTransactionRead,
): HandymanLedgerTransactionRead {
  const tx = raw.transaction as Record<string, unknown>;
  const corrections = raw.corrections.map(mapCorrection);
  const allocations = raw.allocations.map(mapAllocation);

  const lineKinds = new Map<string, string>();
  for (const row of raw.charge_lines) {
    lineKinds.set(text(row.chargeLineId), text(row.lineKind));
  }

  // Adjustments per line kind — never smeared across kinds.
  let laborAdjusted = 0n;
  let materialAdjusted = 0n;
  for (const correction of corrections) {
    if (
      correction.correctionKind !== 'ADJUSTMENT' ||
      correction.sourceChargeLineId === null
    ) {
      continue;
    }
    const kind = lineKinds.get(correction.sourceChargeLineId);
    if (kind === 'LABOR') laborAdjusted += toCents(correction.amount);
    if (kind === 'MATERIAL') materialAdjusted += toCents(correction.amount);
  }

  const chargeLines: HandymanLedgerReadChargeLine[] = raw.charge_lines
    .map((row) => {
      const amount = toCents(row.amount);
      const adjusted = toCents(row.adjusted);
      const allocated = toCents(row.allocated);
      const reversedAllocations = toCents(row.reversedAllocations);
      const applied = allocated - reversedAllocations;
      const netAmount = amount - adjusted;
      return {
        chargeLineId: text(row.chargeLineId),
        quotationLineId: text(row.quotationLineId),
        lineKind: text(row.lineKind) as HandymanLedgerReadChargeLine['lineKind'],
        compositionKind: nullableText(row.compositionKind) as HandymanLedgerReadChargeLine['compositionKind'],
        basisFactKind: nullableText(row.basisFactKind),
        currency: text(row.currency) as HandymanLedgerReadChargeLine['currency'],
        amount: fromCents(amount),
        adjusted: fromCents(adjusted),
        netAmount: fromCents(netAmount),
        allocated: fromCents(allocated),
        reversedAllocations: fromCents(reversedAllocations),
        applied: fromCents(applied),
        outstanding: fromCents(netAmount - applied),
      };
    });

  const payments: HandymanLedgerReadPayment[] = raw.payments.map((row) => {
    const allocated = toCents(row.allocated);
    const reversedAllocations = toCents(row.reversedAllocations);
    const applied = allocated - reversedAllocations;
    const refunded = toCents(row.refunded);
    const reversedPayment = toCents(row.reversedPayment);
    const status = text(row.status) as HandymanLedgerReadPayment['status'];
    const reversedPaymentText = fromCents(reversedPayment);
    return {
      paymentId: text(row.paymentId),
      status,
      channel: text(row.channel),
      currency: text(row.currency) as HandymanLedgerReadPayment['currency'],
      amount: fromCents(toCents(row.amount)),
      receivedAt: new Date(text(row.receivedAt)).toISOString(),
      allocated: fromCents(allocated),
      reversedAllocations: fromCents(reversedAllocations),
      applied: fromCents(applied),
      refunded: fromCents(refunded),
      reversedPayment: reversedPaymentText,
      // Received-and-applied net of refunds; reversed funds are not held.
      netReceived: fromCents(
        reversedPayment > 0n ? 0n : applied - refunded,
      ),
      authoritativeForEntitlement: isHandymanLedgerReadPaymentAuthoritative(
        status,
        reversedPaymentText,
      ),
    };
  });

  let chargedGross = 0n;
  let laborGross = 0n;
  let materialGross = 0n;
  for (const line of chargeLines) {
    chargedGross += toCents(line.amount);
    if (line.lineKind === 'LABOR') laborGross += toCents(line.amount);
    if (line.lineKind === 'MATERIAL') materialGross += toCents(line.amount);
  }
  let adjusted = 0n;
  let refunded = 0n;
  let receivedReversed = 0n;
  const counts: HandymanLedgerReadCorrectionCounts = {
    refunds: 0, reversals: 0, adjustments: 0,
  };
  for (const correction of corrections) {
    const amount = toCents(correction.amount);
    if (correction.correctionKind === 'REFUND') {
      refunded += amount;
      counts.refunds += 1;
    }
    if (correction.correctionKind === 'REVERSAL') {
      counts.reversals += 1;
      if (correction.sourcePaymentId !== null) receivedReversed += amount;
    }
    if (correction.correctionKind === 'ADJUSTMENT') {
      adjusted += amount;
      counts.adjustments += 1;
    }
  }
  let allocated = 0n;
  let reversedAllocations = 0n;
  for (const allocation of allocations) {
    allocated += toCents(allocation.amount);
    if (allocation.reversed) reversedAllocations += toCents(allocation.amount);
  }
  let receivedGross = 0n;
  let pendingPayments = 0;
  for (const payment of payments) {
    if (payment.status === 'CONFIRMED') {
      receivedGross += toCents(payment.amount);
    }
    if (payment.status === 'PENDING') pendingPayments += 1;
  }

  const chargedNet = chargedGross - adjusted;
  const applied = allocated - reversedAllocations;
  const receivedNet = receivedGross - receivedReversed;
  const totals: HandymanLedgerReadTotals = {
    chargedGross: fromCents(chargedGross),
    laborGross: fromCents(laborGross),
    materialGross: fromCents(materialGross),
    laborAdjusted: fromCents(laborAdjusted),
    materialAdjusted: fromCents(materialAdjusted),
    adjustedTransactionScope: fromCents(
      adjusted - laborAdjusted - materialAdjusted,
    ),
    adjusted: fromCents(adjusted),
    chargedNet: fromCents(chargedNet),
    laborNet: fromCents(laborGross - laborAdjusted),
    materialNet: fromCents(materialGross - materialAdjusted),
    allocated: fromCents(allocated),
    reversedAllocations: fromCents(reversedAllocations),
    applied: fromCents(applied),
    receivedGross: fromCents(receivedGross),
    receivedReversed: fromCents(receivedReversed),
    receivedNet: fromCents(receivedNet),
    refunded: fromCents(refunded),
    netReceived: fromCents(receivedNet - refunded),
    outstanding: fromCents(chargedNet - applied),
    corrections: counts,
  };

  const deniedBy: HandymanLedgerReadAuthorityDenial[] = [];
  if (chargeLines.length === 0) deniedBy.push('NO_POSTED_CHARGE_FACTS');
  if (pendingPayments > 0) deniedBy.push('PROVISIONAL_PAYMENTS_PENDING');

  return {
    contractVersion: HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
    readOnly: true,
    transaction: {
      transactionId: text(tx.transactionId),
      clientId: text(tx.clientId),
      executionScopeId: text(tx.executionScopeId),
      quotationVersionId: text(tx.quotationVersionId),
      currency: text(tx.currency) as HandymanLedgerTransactionRead['transaction']['currency'],
      createdAt: new Date(text(tx.createdAt)).toISOString(),
    },
    chargeLines,
    payments,
    allocations,
    corrections,
    totals,
    authority: {
      authoritativeForEntitlement: deniedBy.length === 0,
      deniedBy,
    },
  };
}

/* ---- Published read 2: client-level net basis ------------------- */

/**
 * The bounded, windowed net basis of EVERY ledger transaction of one
 * client — the shape CR-HM-14 gates entitlement derivation on. Returns
 * facts only, never entitlement, and only for a client the actor can
 * access (§9.6).
 */
export async function readHandymanLedgerClientBasisAt(
  clientId: string,
  actorUserId: string,
  options: ReadHandymanLedgerClientBasisOptions = {},
): Promise<HandymanLedgerClientBasisRead> {
  const clientUuid = ensureUuid(clientId, 'clientId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const from = ensureWindow(options.from, 'from');
  const to = ensureWindow(options.to, 'to');
  if (from !== null && to !== null && from >= to) {
    throw handymanLedgerReadInvalidError('window');
  }
  const limit = ensureLimit(options.limit);

  if (!(await handymanLedgerReadRepository.clientExists(clientUuid))) {
    throw handymanCustomerTransactionNotFoundError();
  }
  if (!(await contextAccessService.canAccessClient(actorUuid, clientUuid))) {
    throw handymanCustomerTransactionNotAuthorizedError();
  }

  const rows = await handymanLedgerReadRepository
    .readClientBasisRows(clientUuid, from, to, limit);
  return composeClientBasisRead(clientUuid, from, to, limit, rows);
}

function composeClientBasisRead(
  clientId: string,
  from: string | null,
  to: string | null,
  limit: number,
  rows: RawClientBasisRow[],
): HandymanLedgerClientBasisRead {
  const transactions: HandymanLedgerClientBasisEntry[] = rows.map((row) => {
    const chargedGross = toCents(row.charged_gross);
    const laborGross = toCents(row.labor_gross);
    const materialGross = toCents(row.material_gross);
    const laborAdjusted = toCents(row.labor_adjusted);
    const materialAdjusted = toCents(row.material_adjusted);
    const adjusted = toCents(row.adjusted);
    const allocated = toCents(row.allocated);
    const reversedAllocations = toCents(row.reversed_allocations);
    const applied = allocated - reversedAllocations;
    const receivedGross = toCents(row.received_gross);
    const receivedReversed = toCents(row.reversed_payments);
    const receivedNet = receivedGross - receivedReversed;
    const refunded = toCents(row.refunded);
    const chargedNet = chargedGross - adjusted;

    const deniedBy: HandymanLedgerReadAuthorityDenial[] = [];
    if (chargedGross === 0n) deniedBy.push('NO_POSTED_CHARGE_FACTS');
    if (Number(row.pending_payments) > 0) {
      deniedBy.push('PROVISIONAL_PAYMENTS_PENDING');
    }

    return {
      transactionId: text(row.transaction_id),
      executionScopeId: text(row.execution_scope_id),
      currency: text(row.currency) as HandymanLedgerClientBasisEntry['currency'],
      openedAt: toIso(row.created_at),
      chargedNet: fromCents(chargedNet),
      laborNet: fromCents(laborGross - laborAdjusted),
      materialNet: fromCents(materialGross - materialAdjusted),
      adjusted: fromCents(adjusted),
      applied: fromCents(applied),
      receivedNet: fromCents(receivedNet),
      refunded: fromCents(refunded),
      reversedAllocations: fromCents(reversedAllocations),
      receivedReversed: fromCents(receivedReversed),
      netReceived: fromCents(receivedNet - refunded),
      outstanding: fromCents(chargedNet - applied),
      corrections: {
        refunds: Number(row.refund_count),
        reversals:
          Number(row.payment_reversals) + Number(row.allocation_reversals),
        adjustments: Number(row.adjustment_count),
      },
      authority: {
        authoritativeForEntitlement: deniedBy.length === 0,
        deniedBy,
      },
    };
  });

  const totals = {
    transactionCount: transactions.length,
    chargedNet: 0n,
    laborNet: 0n,
    materialNet: 0n,
    adjusted: 0n,
    applied: 0n,
    receivedNet: 0n,
    refunded: 0n,
    reversedAllocations: 0n,
    receivedReversed: 0n,
    netReceived: 0n,
    outstanding: 0n,
    corrections: { refunds: 0, reversals: 0, adjustments: 0 },
  };
  const denialSet = new Set<HandymanLedgerReadAuthorityDenial>();
  const nonAuthoritative: string[] = [];
  for (const entry of transactions) {
    totals.chargedNet += toCents(entry.chargedNet);
    totals.laborNet += toCents(entry.laborNet);
    totals.materialNet += toCents(entry.materialNet);
    totals.adjusted += toCents(entry.adjusted);
    totals.applied += toCents(entry.applied);
    totals.receivedNet += toCents(entry.receivedNet);
    totals.refunded += toCents(entry.refunded);
    totals.reversedAllocations += toCents(entry.reversedAllocations);
    totals.receivedReversed += toCents(entry.receivedReversed);
    totals.netReceived += toCents(entry.netReceived);
    totals.outstanding += toCents(entry.outstanding);
    totals.corrections.refunds += entry.corrections.refunds;
    totals.corrections.reversals += entry.corrections.reversals;
    totals.corrections.adjustments += entry.corrections.adjustments;
    if (!entry.authority.authoritativeForEntitlement) {
      nonAuthoritative.push(entry.transactionId);
      for (const denial of entry.authority.deniedBy) denialSet.add(denial);
    }
  }

  return {
    contractVersion: HANDYMAN_LEDGER_READ_CONTRACT_VERSION,
    readOnly: true,
    clientId,
    from,
    to,
    limit,
    transactions,
    totals: {
      transactionCount: totals.transactionCount,
      chargedNet: fromCents(totals.chargedNet),
      laborNet: fromCents(totals.laborNet),
      materialNet: fromCents(totals.materialNet),
      adjusted: fromCents(totals.adjusted),
      applied: fromCents(totals.applied),
      receivedNet: fromCents(totals.receivedNet),
      refunded: fromCents(totals.refunded),
      reversedAllocations: fromCents(totals.reversedAllocations),
      receivedReversed: fromCents(totals.receivedReversed),
      netReceived: fromCents(totals.netReceived),
      outstanding: fromCents(totals.outstanding),
      corrections: totals.corrections,
    },
    authority: {
      authoritativeForEntitlement:
        transactions.length > 0 && nonAuthoritative.length === 0,
      deniedBy: [...denialSet].sort(),
      nonAuthoritativeTransactionIds: nonAuthoritative,
    },
  };
}

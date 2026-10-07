import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import {
  handymanCustomerTransactionNotAuthorizedError,
  handymanCustomerTransactionNotFoundError,
  handymanCustomerTransactionScopeNotFoundError,
} from '../handyman-customer-transactions';
import { handymanExecutionScopeRepository }
  from '../handyman-quotations';
import {
  handymanPaymentAllocationConflictError,
  handymanPaymentAllocationInvalidError,
  handymanPaymentAllocationNotFoundError,
} from './handyman-payment-allocation.errors';
import { handymanPaymentAllocationRepository }
  from './handyman-payment-allocation.repository';
import type {
  AllocateHandymanCustomerPaymentInput,
  HandymanPaymentAllocationCommandResult,
  HandymanPaymentAllocationRecord,
  HandymanPaymentAllocationSummary,
} from './handyman-payment-allocation.types';

/**
 * CR-HM-13 PART 04 — ALLOCATE_PAYMENT ONLY (FROZEN governance
 * `CR-HM-13_START_GOVERNANCE.md` §6/§8/§9, §10 row 04, §13 row 04).
 *
 * An allocation binds CONFIRMED received funds to ONE immutable charge
 * line. The ledger re-proves every invariant inside the write
 * transaction — payment status, same ledger transaction, one currency
 * (no FX), the charge line's own LABOR/MATERIAL kind, payment-bounded
 * and charge-bounded caps — and the database guard re-proves them
 * again for every writer. Over-allocation is a bounded conflict, never
 * a silent clamp (§6.2/§6.3).
 *
 * Allocated/unallocated/outstanding figures returned here are DERIVED
 * projections over posted facts, never authored states (§6.6): no
 * "PAID" flag exists anywhere in this ledger.
 *
 * ZERO refund/reversal/adjustment (PART 05), ZERO
 * entitlement/settlement/BM fee, ZERO gateway runtime, ZERO HTTP.
 */

const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})$/;
const FREE_TEXT_MAX = 200;

function ensureUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw handymanPaymentAllocationInvalidError(field);
  }
  return value;
}

function ensureKey(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > FREE_TEXT_MAX
  ) {
    throw handymanPaymentAllocationInvalidError('idempotencyKey');
  }
  return value;
}

/** Canonical decimal strings only — money never becomes a float. */
function ensureAmount(value: unknown): string {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value.trim())) {
    throw handymanPaymentAllocationInvalidError('amount');
  }
  const amount = value.trim();
  // Exact zero check in cents: an allocation of nothing is not an
  // allocation (and the DB would refuse it anyway).
  if (toCents(amount) <= 0n) {
    throw handymanPaymentAllocationInvalidError('amount');
  }
  return amount;
}

/**
 * Exact money comparison in integer cents (bigint): "10.5" -> 1050n.
 * No floating-point arithmetic is ever applied to an amount.
 */
function toCents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return cents;
}

function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = cents % 100n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

/** The CR-HM-13 client-access wall (same law as the ledger module). */
async function authorityPreamble(scopeUuid: string, actorUserId: string) {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanCustomerTransactionScopeNotFoundError();
  if (!(await contextAccessService.canAccessClient(
    actorUserId,
    scope.clientId,
  ))) {
    throw handymanCustomerTransactionNotAuthorizedError();
  }
  return scope;
}

/**
 * Shared locked preamble for allocation reads and writes: the ledger
 * transaction row is locked FIRST, which serializes every allocation
 * mutation of one ledger (allocations can never cross transactions,
 * so this single lock is complete), then the caller's work runs inside
 * that window.
 */
async function lockLedgerTransaction(
  tx: { query: (text: string, params?: unknown[]) => Promise<{
    rows: Record<string, unknown>[];
  }> },
  scopeUuid: string,
) {
  const anchor = await tx.query(
    `SELECT id, client_id, currency, quotation_version_id
       FROM handyman_customer_transactions
      WHERE execution_scope_id = $1
      FOR UPDATE`,
    [scopeUuid],
  );
  const transaction = anchor.rows[0];
  if (!transaction) {
    throw handymanCustomerTransactionNotFoundError();
  }
  return {
    id: transaction.id as string,
    clientId: transaction.client_id as string,
    currency: transaction.currency as string,
  };
}

/**
 * ALLOCATE_PAYMENT: apply `amount` of ONE CONFIRMED payment to ONE
 * immutable charge line. Replay of the SAME key returns the SAME
 * allocation; a key bound to a different allocation is a bounded
 * conflict. Partial allocation is first-class: several payments may
 * fund one line and one payment may fund several lines.
 */
export async function allocateHandymanCustomerPayment(
  input: AllocateHandymanCustomerPaymentInput,
  actorUserId: string,
): Promise<HandymanPaymentAllocationCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const paymentUuid = ensureUuid(input.paymentId, 'paymentId');
  const chargeLineUuid = ensureUuid(input.chargeLineId, 'chargeLineId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const requested = ensureAmount(input.amount);

  await authorityPreamble(scopeUuid, actorUuid);

  return withTransaction(async (tx) => {
    const transaction = await lockLedgerTransaction(tx, scopeUuid);

    const paymentRows = await tx.query(
      `SELECT id, client_id, transaction_id, status, amount, currency
         FROM handyman_customer_payments
        WHERE id = $1
        FOR UPDATE`,
      [paymentUuid],
    );
    const payment = paymentRows.rows[0];
    if (
      !payment ||
      payment.transaction_id !== transaction.id ||
      payment.client_id !== transaction.clientId
    ) {
      // A foreign or unknown payment is never resolved into this
      // ledger's allocation: bounded, never fabricated.
      throw handymanPaymentAllocationNotFoundError('payment-not-in-ledger');
    }
    if (payment.status !== 'CONFIRMED') {
      // §5.3: only confirmed received funds may be allocated. A
      // recorded claim is never authority, and a rejected claim is
      // terminal.
      throw handymanPaymentAllocationConflictError(
        `payment-not-confirmed-${String(payment.status).toLowerCase()}`,
      );
    }
    const chargeRows = await tx.query(
      `SELECT id, client_id, transaction_id, line_kind, currency, amount
         FROM handyman_charge_lines
        WHERE id = $1
        FOR UPDATE`,
      [chargeLineUuid],
    );
    const chargeLine = chargeRows.rows[0];
    if (
      !chargeLine ||
      chargeLine.transaction_id !== transaction.id ||
      chargeLine.client_id !== transaction.clientId
    ) {
      throw handymanPaymentAllocationNotFoundError(
        'charge-line-not-in-ledger',
      );
    }

    // -------- idempotent replay (same key = same allocation) ------
    const replay = await handymanPaymentAllocationRepository
      .findAllocationByKey(tx, transaction.id, key);
    if (replay) {
      if (
        replay.paymentId !== paymentUuid ||
        replay.chargeLineId !== chargeLineUuid ||
        toCents(replay.amount) !== toCents(requested)
      ) {
        // One idempotency key is spent once: a key reused for a
        // DIFFERENT allocation intent is a bounded conflict.
        throw handymanPaymentAllocationConflictError(
          'idempotency-key-bound-to-another-allocation',
        );
      }
      const paymentAllocated = await handymanPaymentAllocationRepository
        .sumAllocatedForPayment(tx, paymentUuid);
      const chargeLineAllocated = await handymanPaymentAllocationRepository
        .sumAllocatedForChargeLine(tx, chargeLineUuid);
      return {
        allocation: replay,
        ...derive(
          String(payment.amount), paymentAllocated,
          String(chargeLine.amount), chargeLineAllocated,
        ),
        replayed: true,
      };
    }

    // -------- one currency, always (no FX, no implicit rate) ------
    if (
      String(payment.currency) !== transaction.currency ||
      String(chargeLine.currency) !== transaction.currency
    ) {
      throw handymanPaymentAllocationConflictError(
        'currency-mismatch-in-ledger',
      );
    }

    // -------- bounded caps (payment + charge line) ----------------
    const paymentAllocatedBefore = await handymanPaymentAllocationRepository
      .sumAllocatedForPayment(tx, paymentUuid);
    const chargeAllocatedBefore = await handymanPaymentAllocationRepository
      .sumAllocatedForChargeLine(tx, chargeLineUuid);
    const requestedCents = toCents(requested);
    const paymentUnallocatedBefore =
      toCents(String(payment.amount)) - toCents(paymentAllocatedBefore);
    if (requestedCents > paymentUnallocatedBefore) {
      throw handymanPaymentAllocationConflictError(
        'exceeds-payment-unallocated-amount',
      );
    }
    const chargeOutstandingBefore =
      toCents(String(chargeLine.amount)) - toCents(chargeAllocatedBefore);
    if (requestedCents > chargeOutstandingBefore) {
      throw handymanPaymentAllocationConflictError(
        'exceeds-charge-line-outstanding-amount',
      );
    }

    const allocation = await handymanPaymentAllocationRepository
      .insertAllocation(tx, {
        clientId: transaction.clientId,
        transactionId: transaction.id,
        paymentId: paymentUuid,
        chargeLineId: chargeLineUuid,
        // The charge line's OWN kind: LABOR and MATERIAL never merge.
        lineKind: chargeLine.line_kind as 'LABOR' | 'MATERIAL',
        currency: transaction.currency,
        amount: requested,
        allocatedByUserId: actorUuid,
        idempotencyKey: key,
      });
    const paymentAllocated = await handymanPaymentAllocationRepository
      .sumAllocatedForPayment(tx, paymentUuid);
    const chargeLineAllocated = await handymanPaymentAllocationRepository
      .sumAllocatedForChargeLine(tx, chargeLineUuid);
    return {
      allocation,
      ...derive(
        String(payment.amount), paymentAllocated,
        String(chargeLine.amount), chargeLineAllocated,
      ),
      replayed: false,
    };
  });
}

function derive(
  paymentAmount: string,
  paymentAllocated: string,
  chargeLineAmount: string,
  chargeLineAllocated: string,
) {
  return {
    paymentAllocated,
    paymentUnallocated: fromCents(
      toCents(paymentAmount) - toCents(paymentAllocated),
    ),
    chargeLineAllocated,
    chargeLineOutstanding: fromCents(
      toCents(chargeLineAmount) - toCents(chargeLineAllocated),
    ),
  };
}

/** Facts only (the published read contract is PART 06). */
export async function listHandymanPaymentAllocations(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanPaymentAllocationRecord[]> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await authorityPreamble(scopeUuid, actorUuid);
  return withTransaction(async (tx) => {
    const transaction = await lockLedgerTransaction(tx, scopeUuid);
    return handymanPaymentAllocationRepository
      .listAllocationsByTransaction(tx, transaction.id);
  });
}

/**
 * DERIVED allocation summary (§6.6): computed from posted facts at
 * read time. Nothing here is stored, so it can never disagree with
 * the ledger — and a line with partial funding simply shows its
 * outstanding remainder, never a forged "paid" state.
 */
export async function summarizeHandymanPaymentAllocations(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanPaymentAllocationSummary> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await authorityPreamble(scopeUuid, actorUuid);
  return withTransaction(async (tx) => {
    const transaction = await lockLedgerTransaction(tx, scopeUuid);
    const payments = await tx.query(
      `SELECT p.id, p.status, p.amount::text AS amount,
              COALESCE(a.total, 0)::numeric(18, 2)::text AS allocated
         FROM handyman_customer_payments p
         LEFT JOIN (
           SELECT payment_id, SUM(amount) AS total
             FROM handyman_payment_allocations GROUP BY payment_id
         ) a ON a.payment_id = p.id
        WHERE p.transaction_id = $1
        ORDER BY p.received_at ASC, p.id ASC`,
      [transaction.id],
    );
    const lines = await tx.query(
      `SELECT l.id, l.line_kind, l.amount::text AS amount,
              COALESCE(a.total, 0)::numeric(18, 2)::text AS allocated
         FROM handyman_charge_lines l
         LEFT JOIN (
           SELECT charge_line_id, SUM(amount) AS total
             FROM handyman_payment_allocations GROUP BY charge_line_id
         ) a ON a.charge_line_id = l.id
        WHERE l.transaction_id = $1
        ORDER BY l.created_at ASC, l.id ASC`,
      [transaction.id],
    );
    let totalAllocated = 0n;
    for (const row of payments.rows) {
      totalAllocated += toCents(String(row.allocated));
    }
    return {
      transactionId: transaction.id,
      currency: transaction.currency,
      payments: payments.rows.map((row) => ({
        paymentId: row.id as string,
        status: row.status as string,
        amount: String(row.amount),
        allocated: String(row.allocated),
        unallocated: fromCents(
          toCents(String(row.amount)) - toCents(String(row.allocated)),
        ),
      })),
      chargeLines: lines.rows.map((row) => ({
        chargeLineId: row.id as string,
        lineKind: row.line_kind as 'LABOR' | 'MATERIAL',
        amount: String(row.amount),
        allocated: String(row.allocated),
        outstanding: fromCents(
          toCents(String(row.amount)) - toCents(String(row.allocated)),
        ),
      })),
      totalAllocated: fromCents(totalAllocated),
    };
  });
}

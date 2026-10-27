import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
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
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const magnitude = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -magnitude : magnitude;
}

function fromCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const magnitude = cents < 0n ? -cents : cents;
  return `${sign}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
}

/**
 * The CR-HM-13 access wall (same law as the ledger module): an
 * unknown scope is a bounded 404 (never fabricated) and an actor
 * without access to the scope's exact Building is a bounded 403.
 */
async function authorityPreamble(scopeUuid: string, actorUserId: string) {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanCustomerTransactionScopeNotFoundError();
  // CR-HM-SEC-01 PART 06F-1 — BE-02G exact-Building check on the
  // authoritative server-derived scope building (migration 0395),
  // replacing the client-level canAccessClient shortcut: a same-Client
  // sibling Building assignment must not allocate funds or read the
  // allocation ledger. The module's denial vocabulary (403
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

    // A REDUCE binding is provenance for a canonical line adjustment, not
    // another deduction. Existing un-reduced allocation behavior is unchanged.
    const reduced = await tx.query<{ amount: string }>(`SELECT
      (l.amount-COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
        WHERE c.correction_kind='ADJUSTMENT' AND c.source_charge_line_id=l.id),0))::numeric(18,2)::text AS amount
      FROM handyman_charge_lines l WHERE l.id=$1 AND EXISTS
        (SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.charge_line_id=l.id)`,
    [chargeLineUuid]);
    const allocationChargeAmount = reduced.rows[0]?.amount ?? String(chargeLine.amount);

    // Net applied basis (CR-HM-E2E-LIFECYCLE-01 repair): allocation
    // facts are immutable, but a PART 05 ALLOCATION REVERSAL negates
    // one exactly, and the correction law + PART 06 read both stop
    // counting it toward the applied amount. Caps and derived figures
    // below therefore net reversed allocations; the gross fact sum
    // remains available in the module summary for audit.
    const netAllocated = async () => {
      const [grossPayment, reversedPayment, grossLine, reversedLine] =
        await Promise.all([
          handymanPaymentAllocationRepository.sumAllocatedForPayment(
            tx, paymentUuid),
          handymanPaymentAllocationRepository
            .sumReversedAllocationsForPayment(tx, paymentUuid),
          handymanPaymentAllocationRepository.sumAllocatedForChargeLine(
            tx, chargeLineUuid),
          handymanPaymentAllocationRepository
            .sumReversedAllocationsForChargeLine(tx, chargeLineUuid),
        ]);
      return {
        paymentAllocated: fromCents(
          toCents(grossPayment) - toCents(reversedPayment)),
        chargeLineAllocated: fromCents(
          toCents(grossLine) - toCents(reversedLine)),
      };
    };

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
      const { paymentAllocated, chargeLineAllocated } = await netAllocated();
      return {
        allocation: replay,
        ...derive(
          String(payment.amount), paymentAllocated,
          allocationChargeAmount, chargeLineAllocated,
        ),
        replayed: true,
      };
    }

    // New Handyman invoice-bound payments may be allocated only through
    // a charge line on that exact finalized, single-scope invoice. Legacy
    // ledgers with no invoice binding retain their historical allocation
    // behavior; once the scope is invoiced this gate is mandatory.
    const invoiceRows = await tx.query(
      `SELECT i.id, i.status,
              EXISTS (
                SELECT 1 FROM tenant_invoice_lines il
                 WHERE il.invoice_id = i.id
                   AND il.handyman_charge_line_id = $2
              ) AS line_linked
         FROM tenant_invoices i
        WHERE i.handyman_execution_scope_id = $1
        FOR SHARE`,
      [scopeUuid, chargeLineUuid],
    );
    const invoice = invoiceRows.rows[0];
    if (invoice && (invoice.status !== 'FINALIZED' || invoice.line_linked !== true)) {
      throw handymanPaymentAllocationConflictError(
        'charge-line-not-linked-to-finalized-handyman-invoice',
      );
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

    // -------- bounded caps (payment + charge line, net basis) -----
    const {
      paymentAllocated: paymentAllocatedBefore,
      chargeLineAllocated: chargeAllocatedBefore,
    } = await netAllocated();
    const requestedCents = toCents(requested);
    const paymentUnallocatedBefore =
      toCents(String(payment.amount)) - toCents(paymentAllocatedBefore);
    if (requestedCents > paymentUnallocatedBefore) {
      throw handymanPaymentAllocationConflictError(
        'exceeds-payment-unallocated-amount',
      );
    }
    const chargeOutstandingBefore =
      toCents(allocationChargeAmount) - toCents(chargeAllocatedBefore);
    if (requestedCents > chargeOutstandingBefore) {
      throw handymanPaymentAllocationConflictError(
        'exceeds-charge-line-outstanding-amount',
      );
    }

    let allocation;
    try {
      allocation = await handymanPaymentAllocationRepository
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
    } catch (error) {
      // CR-HM-E2E-LIFECYCLE-01 final gate: the DB guard (0413, net caps
      // since 0447) is the backstop for races the service pre-check
      // cannot see; its raw pg errors must not surface as HTTP 500s.
      const message = (error as { message?: string })?.message ?? '';
      if (/allocation exceeds the payment amount/.test(message)) {
        throw handymanPaymentAllocationConflictError(
          'exceeds-payment-unallocated-amount',
        );
      }
      if (/allocation exceeds the charge line amount|Allocation exceeds the corrected REDUCE charge line/.test(message)) {
        throw handymanPaymentAllocationConflictError(
          'exceeds-charge-line-outstanding-amount',
        );
      }
      throw error;
    }
    const { paymentAllocated, chargeLineAllocated } = await netAllocated();
    return {
      allocation,
      ...derive(
        String(payment.amount), paymentAllocated,
        allocationChargeAmount, chargeLineAllocated,
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
 * outstanding remainder, never a forged "paid" state. On a REDUCE ledger,
 * line amounts include canonical adjustments and allocations include reversals;
 * legacy summaries on other ledgers retain their existing semantics.
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
              (COALESCE(a.total, 0) - CASE WHEN EXISTS (
                SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.transaction_id=p.transaction_id
              ) THEN COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
                  JOIN handyman_payment_allocations pa ON pa.id=c.source_allocation_id
                 WHERE c.correction_kind='REVERSAL' AND pa.payment_id=p.id),0) ELSE 0 END
              )::numeric(18, 2)::text AS allocated
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
      `SELECT l.id, l.line_kind,
              (l.amount - CASE WHEN EXISTS (
                SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.transaction_id=l.transaction_id
              ) THEN COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
                 WHERE c.correction_kind='ADJUSTMENT' AND c.source_charge_line_id=l.id),0) ELSE 0 END
              )::numeric(18,2)::text AS amount,
              (COALESCE(a.total, 0) - CASE WHEN EXISTS (
                SELECT 1 FROM handyman_reduce_financial_corrections b WHERE b.transaction_id=l.transaction_id
              ) THEN COALESCE((SELECT sum(c.amount) FROM handyman_ledger_corrections c
                  JOIN handyman_payment_allocations pa ON pa.id=c.source_allocation_id
                 WHERE c.correction_kind='REVERSAL' AND pa.charge_line_id=l.id),0) ELSE 0 END
              )::numeric(18, 2)::text AS allocated
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

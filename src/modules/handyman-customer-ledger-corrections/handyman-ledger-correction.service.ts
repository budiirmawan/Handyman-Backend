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
  handymanLedgerCorrectionConflictError,
  handymanLedgerCorrectionInvalidError,
  handymanLedgerCorrectionNotFoundError,
} from './handyman-ledger-correction.errors';
import { handymanLedgerCorrectionRepository }
  from './handyman-ledger-correction.repository';
import type {
  AdjustHandymanCustomerLedgerInput,
  HandymanLedgerCorrectionCommandResult,
  HandymanLedgerCorrectionKind,
  HandymanLedgerCorrectionRecord,
  HandymanLedgerCorrectionSourceKind,
  HandymanLedgerCorrectionSummary,
  NewHandymanLedgerCorrection,
  RefundHandymanCustomerPaymentInput,
  ReverseHandymanAllocationInput,
  ReverseHandymanPaymentInput,
} from './handyman-ledger-correction.types';

/**
 * CR-HM-13 PART 05 — REFUND / REVERSAL / ADJUSTMENT ONLY (FROZEN
 * governance `CR-HM-13_START_GOVERNANCE.md` §7/§8/§9, §10 row 05,
 * §13 row 05).
 *
 * History is IMMUTABLE: nothing here updates or deletes a prior fact.
 * A correction is a NEW forward-only fact carrying its own timestamp,
 * actor and bounded reason, bound to the exact source it corrects:
 *
 *  - REFUND: from a CONFIRMED payment, capped by what was actually
 *    RECEIVED AND APPLIED (its allocations, net of reversed ones).
 *  - REVERSAL: negates ONE specific fact exactly (an allocation, or a
 *    payment whose allocations are no longer live) and only ONCE.
 *  - ADJUSTMENT: an explicit reasoned delta against a charge line or
 *    the transaction, bounded by that line / that transaction total —
 *    it never rewrites the underlying line.
 *
 * Every law is re-proved by the database guard for every writer, so a
 * raw SQL path cannot bypass them. Corrections never cross ledger
 * transactions or clients (§7.5) and never write back into
 * CR-HM-06/09/11 (B5).
 *
 * ZERO entitlement/settlement/BM fee, ZERO gateway runtime, ZERO HTTP.
 */

const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})$/;
const FREE_TEXT_MAX = 200;

function ensureUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw handymanLedgerCorrectionInvalidError(field);
  }
  return value;
}

function ensureKey(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > FREE_TEXT_MAX
  ) {
    throw handymanLedgerCorrectionInvalidError('idempotencyKey');
  }
  return value;
}

/** Canonical `NNN.NN` (at most 2 decimals) and strictly positive. */
function ensureAmount(value: unknown, field = 'amount'): string {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value.trim())) {
    throw handymanLedgerCorrectionInvalidError(field);
  }
  const amount = value.trim();
  if (toCents(amount) <= 0n) {
    throw handymanLedgerCorrectionInvalidError(field);
  }
  return amount;
}

/** Bounded reason: every correction is reasoned (§7.3). */
function ensureReason(value: unknown): string {
  if (typeof value !== 'string') {
    throw handymanLedgerCorrectionInvalidError('reason');
  }
  const reason = value.trim();
  if (reason.length === 0 || reason.length > FREE_TEXT_MAX) {
    throw handymanLedgerCorrectionInvalidError('reason');
  }
  return reason;
}

/** Exact money comparison in integer cents — never a float. */
function toCents(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function fromCents(cents: bigint): string {
  const whole = cents / 100n;
  const fraction = cents < 0n ? -cents % 100n : cents % 100n;
  return `${whole}.${fraction.toString().padStart(2, '0')}`;
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
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
  // CR-HM-SEC-01 PART 06F-2 — BE-02G exact-Building check on the
  // authoritative server-derived scope building (migration 0395),
  // replacing the client-level canAccessClient shortcut: a same-Client
  // sibling Building assignment must not post corrections or read the
  // correction ledger. The module's denial vocabulary (403
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

type TxExecutor = {
  query: (text: string, params?: unknown[]) => Promise<{
    rows: Record<string, unknown>[];
  }>;
};

/**
 * Shared locked preamble: the ledger transaction row is locked FIRST
 * (corrections can never cross transactions, so this single lock
 * serializes every correction of one ledger), then the caller's work
 * runs inside that window.
 */
async function lockLedgerTransaction(tx: TxExecutor, scopeUuid: string) {
  const anchor = await tx.query(
    `SELECT id, client_id, currency
       FROM handyman_customer_transactions
      WHERE execution_scope_id = $1
      FOR UPDATE`,
    [scopeUuid],
  );
  const transaction = anchor.rows[0];
  if (!transaction) throw handymanCustomerTransactionNotFoundError();
  return {
    id: transaction.id as string,
    clientId: transaction.client_id as string,
    currency: transaction.currency as string,
  };
}

type CorrectionIntent = {
  correctionKind: HandymanLedgerCorrectionKind;
  sourceKind: HandymanLedgerCorrectionSourceKind;
  sourcePaymentId?: string | null;
  sourceAllocationId?: string | null;
  sourceChargeLineId?: string | null;
  /** `null` for reversals: the source fact's amount IS the amount. */
  amount: string | null;
  reason: string;
  idempotencyKey: string;
};

/**
 * Records ONE forward-only correction fact. The intent (kind + source +
 * amount) is resolved server-side first — where invariants depend on
 * live ledger state they are re-proved by the database guard inside the
 * same transaction — and a replayed key returns the SAME fact.
 */
async function recordCorrection(
  scopeUuid: string,
  actorUuid: string,
  intent: CorrectionIntent,
): Promise<HandymanLedgerCorrectionCommandResult> {
  return withTransaction(async (tx) => {
    const transaction = await lockLedgerTransaction(tx, scopeUuid);
    const replay = await handymanLedgerCorrectionRepository
      .findCorrectionByKey(tx, transaction.id, intent.idempotencyKey);
    if (replay) {
      // A replay converges on the SAME fact — but only when the intent
      // matches: one key is spent once.
      if (
        replay.correctionKind !== intent.correctionKind ||
        replay.sourceKind !== intent.sourceKind ||
        (replay.sourcePaymentId ?? null) !==
          (intent.sourcePaymentId ?? null) ||
        (replay.sourceAllocationId ?? null) !==
          (intent.sourceAllocationId ?? null) ||
        (replay.sourceChargeLineId ?? null) !==
          (intent.sourceChargeLineId ?? null) ||
        (intent.amount !== null &&
          toCents(replay.amount) !== toCents(intent.amount))
      ) {
        throw handymanLedgerCorrectionConflictError(
          'idempotency-key-bound-to-another-correction',
        );
      }
      return { correction: replay, replayed: true };
    }

    await assertSourceInLedger(tx, transaction.id, intent);
    const record: NewHandymanLedgerCorrection = {
      clientId: transaction.clientId,
      transactionId: transaction.id,
      correctionKind: intent.correctionKind,
      sourceKind: intent.sourceKind,
      sourcePaymentId: intent.sourcePaymentId ?? null,
      sourceAllocationId: intent.sourceAllocationId ?? null,
      sourceChargeLineId: intent.sourceChargeLineId ?? null,
      currency: transaction.currency,
      // Reversal amounts are the source fact's OWN amount: the ledger
      // negates a specific fact, never a caller-chosen figure.
      amount: intent.amount ?? await resolveReversalAmount(
        tx, transaction.id, intent),
      reason: intent.reason,
      correctedByUserId: actorUuid,
      idempotencyKey: intent.idempotencyKey,
    };
    const correction = await handymanLedgerCorrectionRepository
      .insertCorrection(tx, record);
    return { correction, replayed: false };
  });
}

/**
 * The source must belong to THIS ledger transaction: a correction can
 * never name a fact of another transaction/client (§7.5), and an
 * unknown or foreign source is simply NOT FOUND here (never leaked).
 */
async function assertSourceInLedger(
  tx: TxExecutor,
  transactionId: string,
  intent: CorrectionIntent,
): Promise<void> {
  if (intent.sourceKind === 'PAYMENT') {
    const rows = await tx.query(
      `SELECT 1 FROM handyman_customer_payments
        WHERE id = $1 AND transaction_id = $2`,
      [intent.sourcePaymentId, transactionId],
    );
    if (!rows.rows[0]) {
      throw handymanLedgerCorrectionNotFoundError('payment-not-found');
    }
    return;
  }
  if (intent.sourceKind === 'CHARGE_LINE') {
    const rows = await tx.query(
      `SELECT 1 FROM handyman_charge_lines
        WHERE id = $1 AND transaction_id = $2`,
      [intent.sourceChargeLineId, transactionId],
    );
    if (!rows.rows[0]) {
      throw handymanLedgerCorrectionNotFoundError('charge-line-not-found');
    }
  }
  // ALLOCATION sources are resolved (and existence-proved) by the
  // reversal amount resolution below; TRANSACTION scope is the locked
  // ledger transaction itself.
}

/** The amount a reversal must negate, read from the source fact. */
async function resolveReversalAmount(
  tx: TxExecutor,
  transactionId: string,
  intent: CorrectionIntent,
): Promise<string> {
  if (intent.sourceAllocationId) {
    const rows = await tx.query(
      `SELECT amount::text AS amount FROM handyman_payment_allocations
        WHERE id = $1 AND transaction_id = $2`,
      [intent.sourceAllocationId, transactionId],
    );
    if (!rows.rows[0]) {
      throw handymanLedgerCorrectionNotFoundError('allocation-not-found');
    }
    return String(rows.rows[0].amount);
  }
  const rows = await tx.query(
    `SELECT amount::text AS amount FROM handyman_customer_payments
      WHERE id = $1 AND transaction_id = $2`,
    [intent.sourcePaymentId, transactionId],
  );
  if (!rows.rows[0]) {
    throw handymanLedgerCorrectionNotFoundError('payment-not-found');
  }
  return String(rows.rows[0].amount);
}

/**
 * REFUND_PAYMENT: return funds to the customer against ONE confirmed
 * payment. The refund is bounded by what was actually received AND
 * APPLIED — allocations of that payment net of reversed allocations —
 * and partial refunds accumulate fail-closed (§7.2).
 */
export async function refundHandymanCustomerPayment(
  input: RefundHandymanCustomerPaymentInput,
  actorUserId: string,
): Promise<HandymanLedgerCorrectionCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const paymentUuid = ensureUuid(input.paymentId, 'paymentId');
  const key = ensureKey(input.idempotencyKey);
  const amount = ensureAmount(input.amount);
  const reason = ensureReason(input.reason);

  await authorityPreamble(scopeUuid, actorUuid);
  return recordCorrection(scopeUuid, actorUuid, {
    correctionKind: 'REFUND',
    sourceKind: 'PAYMENT',
    sourcePaymentId: paymentUuid,
    amount,
    reason,
    idempotencyKey: key,
  });
}

/**
 * REVERSE_ALLOCATION: negate ONE allocation fact exactly. A fact may be
 * reversed at most once; a reversed allocation stops counting toward
 * the applied amount (which is what a refund is bounded by).
 */
export async function reverseHandymanPaymentAllocation(
  input: ReverseHandymanAllocationInput,
  actorUserId: string,
): Promise<HandymanLedgerCorrectionCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const allocationUuid = ensureUuid(input.allocationId, 'allocationId');
  const key = ensureKey(input.idempotencyKey);
  const reason = ensureReason(input.reason);

  await authorityPreamble(scopeUuid, actorUuid);
  return recordCorrection(scopeUuid, actorUuid, {
    correctionKind: 'REVERSAL',
    sourceKind: 'ALLOCATION',
    sourceAllocationId: allocationUuid,
    amount: null,
    reason,
    idempotencyKey: key,
  });
}

/**
 * REVERSE_PAYMENT: negate ONE confirmed payment exactly. Lawful only
 * once every allocation of that payment is itself reversed — funds
 * cannot be un-received while they are still applied to charge lines.
 */
export async function reverseHandymanCustomerPayment(
  input: ReverseHandymanPaymentInput,
  actorUserId: string,
): Promise<HandymanLedgerCorrectionCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const paymentUuid = ensureUuid(input.paymentId, 'paymentId');
  const key = ensureKey(input.idempotencyKey);
  const reason = ensureReason(input.reason);

  await authorityPreamble(scopeUuid, actorUuid);
  return recordCorrection(scopeUuid, actorUuid, {
    correctionKind: 'REVERSAL',
    sourceKind: 'PAYMENT',
    sourcePaymentId: paymentUuid,
    amount: null,
    reason,
    idempotencyKey: key,
  });
}

/**
 * ADJUST_LEDGER: an explicit, reasoned delta against ONE charge line or
 * against the transaction. The delta is bounded by the line amount (or
 * by the transaction's total charge) and NEVER rewrites the underlying
 * line — the charge line stays byte-stable forever (§7.2).
 */
export async function adjustHandymanCustomerLedger(
  input: AdjustHandymanCustomerLedgerInput,
  actorUserId: string,
): Promise<HandymanLedgerCorrectionCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const amount = ensureAmount(input.amount);
  const reason = ensureReason(input.reason);
  const chargeLineUuid = input.chargeLineId == null
    ? null
    : ensureUuid(input.chargeLineId, 'chargeLineId');

  await authorityPreamble(scopeUuid, actorUuid);
  return recordCorrection(scopeUuid, actorUuid, {
    correctionKind: 'ADJUSTMENT',
    sourceKind: chargeLineUuid ? 'CHARGE_LINE' : 'TRANSACTION',
    sourceChargeLineId: chargeLineUuid,
    amount,
    reason,
    idempotencyKey: key,
  });
}

/** Facts only (the published read contract is PART 06). */
export async function listHandymanLedgerCorrections(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanLedgerCorrectionRecord[]> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await authorityPreamble(scopeUuid, actorUuid);
  return withTransaction(async (tx) => {
    const transaction = await lockLedgerTransaction(tx, scopeUuid);
    return handymanLedgerCorrectionRepository
      .listCorrectionsByTransaction(tx, transaction.id);
  });
}

/**
 * DERIVED net view (§7.4): downstream consumers must see net, never
 * gross-only. Everything here is computed from posted facts at read
 * time — nothing is stored, so it can never disagree with the ledger.
 */
export async function summarizeHandymanLedgerCorrections(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanLedgerCorrectionSummary> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await authorityPreamble(scopeUuid, actorUuid);
  return withTransaction(async (tx) => {
    const transaction = await lockLedgerTransaction(tx, scopeUuid);
    const payments = await tx.query(
      `SELECT p.id, p.status, p.amount::text AS amount,
              COALESCE(a.allocated, 0)::numeric(18, 2)::text AS allocated,
              COALESCE(a.reversed, 0)::numeric(18, 2)::text AS reversed,
              COALESCE(r.refunded, 0)::numeric(18, 2)::text AS refunded,
              COALESCE(v.reversed_payment, 0)::numeric(18, 2)::text
                AS reversed_payment
         FROM handyman_customer_payments p
         LEFT JOIN (
           SELECT al.payment_id,
                  SUM(al.amount) AS allocated,
                  COALESCE(SUM(al.amount) FILTER (
                    WHERE EXISTS (
                      SELECT 1 FROM handyman_ledger_corrections c
                      WHERE c.correction_kind = 'REVERSAL'
                        AND c.source_allocation_id = al.id)
                  ), 0) AS reversed
             FROM handyman_payment_allocations al
            GROUP BY al.payment_id
         ) a ON a.payment_id = p.id
         LEFT JOIN (
           SELECT source_payment_id, SUM(amount) AS refunded
             FROM handyman_ledger_corrections
            WHERE correction_kind = 'REFUND'
            GROUP BY source_payment_id
         ) r ON r.source_payment_id = p.id
         LEFT JOIN (
           SELECT source_payment_id, SUM(amount) AS reversed_payment
             FROM handyman_ledger_corrections
            WHERE correction_kind = 'REVERSAL'
              AND source_payment_id IS NOT NULL
            GROUP BY source_payment_id
         ) v ON v.source_payment_id = p.id
        WHERE p.transaction_id = $1
        ORDER BY p.received_at ASC, p.id ASC`,
      [transaction.id],
    );
    const lines = await tx.query(
      `SELECT l.id, l.line_kind, l.amount::text AS amount,
              COALESCE(a.allocated, 0)::numeric(18, 2)::text AS allocated,
              COALESCE(d.adjusted, 0)::numeric(18, 2)::text AS adjusted
         FROM handyman_charge_lines l
         LEFT JOIN (
           SELECT charge_line_id, SUM(amount) AS allocated
             FROM handyman_payment_allocations
            GROUP BY charge_line_id
         ) a ON a.charge_line_id = l.id
         LEFT JOIN (
           SELECT source_charge_line_id, SUM(amount) AS adjusted
             FROM handyman_ledger_corrections
            WHERE correction_kind = 'ADJUSTMENT'
              AND source_charge_line_id IS NOT NULL
            GROUP BY source_charge_line_id
         ) d ON d.source_charge_line_id = l.id
        WHERE l.transaction_id = $1
        ORDER BY l.created_at ASC, l.id ASC`,
      [transaction.id],
    );
    const totals = await tx.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (
           WHERE correction_kind = 'REFUND'), 0)::numeric(18, 2)::text
           AS refunded,
         COALESCE(SUM(amount) FILTER (
           WHERE correction_kind = 'REVERSAL'
             AND source_allocation_id IS NOT NULL), 0)::numeric(18, 2)::text
           AS reversed_allocations,
         COALESCE(SUM(amount) FILTER (
           WHERE correction_kind = 'REVERSAL'
             AND source_payment_id IS NOT NULL), 0)::numeric(18, 2)::text
           AS reversed_payments,
         COALESCE(SUM(amount) FILTER (
           WHERE correction_kind = 'ADJUSTMENT'), 0)::numeric(18, 2)::text
           AS adjusted
       FROM handyman_ledger_corrections
      WHERE transaction_id = $1`,
      [transaction.id],
    );
    const total = totals.rows[0];
    return {
      transactionId: transaction.id,
      currency: transaction.currency,
      payments: payments.rows.map((row) => {
        // Received AND applied, net of reversed allocations; the
        // refundable remainder is what a further refund may consume.
        const applied =
          toCents(String(row.allocated)) - toCents(String(row.reversed));
        const refunded = toCents(String(row.refunded));
        return {
          paymentId: row.id as string,
          status: row.status as string,
          amount: String(row.amount),
          allocated: String(row.allocated),
          applied: fromCents(applied),
          refunded: String(row.refunded),
          refundable: fromCents(
            min(applied, toCents(String(row.amount))) - refunded,
          ),
          reversed: toCents(String(row.reversed_payment)) > 0n,
        };
      }),
      chargeLines: lines.rows.map((row) => ({
        chargeLineId: row.id as string,
        lineKind: row.line_kind as 'LABOR' | 'MATERIAL',
        amount: String(row.amount),
        allocated: String(row.allocated),
        adjusted: String(row.adjusted),
      })),
      totals: {
        refunded: String(total.refunded),
        reversedAllocations: String(total.reversed_allocations),
        reversedPayments: String(total.reversed_payments),
        adjusted: String(total.adjusted),
      },
    };
  });
}

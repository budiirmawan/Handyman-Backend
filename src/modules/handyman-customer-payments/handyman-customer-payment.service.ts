import { getPool, withTransaction } from '../../database';
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
  handymanCustomerPaymentConflictError,
  handymanCustomerPaymentInvalidError,
  handymanCustomerPaymentNotFoundError,
} from './handyman-customer-payment.errors';
import { handymanCustomerPaymentRepository }
  from './handyman-customer-payment.repository';
import {
  isHandymanCustomerPaymentChannel,
  type ConfirmHandymanCustomerPaymentInput,
  type HandymanCustomerPaymentCommandResult,
  type HandymanCustomerPaymentRecord,
  type RecordHandymanCustomerPaymentInput,
  type RejectHandymanCustomerPaymentInput,
} from './handyman-customer-payment.types';

/**
 * CR-HM-13 PART 03 — RECORD_PAYMENT + CONFIRM_PAYMENT + REJECT_PAYMENT
 * ONLY (FROZEN governance `CR-HM-13_START_GOVERNANCE.md` §5/§8/§9, §10
 * row 03, §13 row 03).
 *
 * Payment truth is LEDGER-AUTHORITATIVE: a payment is recorded as
 * `PENDING` and becomes authoritative received funds ONLY through the
 * bounded, replay-safe, server-side confirmation path implemented
 * here. A notification, callback, claim, quotation approval, or BAST
 * acceptance never asserts payment (§5.3, CR-HM-06 F11, CR-HM-11).
 *
 * Provider-neutral by construction: the caller supplies a neutral
 * channel plus BOUNDED free-text provider/reference strings; there is
 * no provider enum, no provider object, no adapter, no SDK, and no
 * named-provider vocabulary anywhere in this path (§5.1/§5.2).
 *
 * ZERO allocation (PART 04), ZERO refund/reversal/adjustment
 * (PART 05), ZERO entitlement/settlement/BM fee, ZERO HTTP.
 */

const PG_UNIQUE_VIOLATION = '23505';
/** Canonical money shape: at most 2 decimals, no sign, no float. */
const MONEY_PATTERN = /^\d{1,16}(\.\d{1,2})$/;
const FREE_TEXT_MAX = 200;

function ensureUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw handymanCustomerPaymentInvalidError(field);
  }
  return value;
}

function ensureKey(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > FREE_TEXT_MAX
  ) {
    throw handymanCustomerPaymentInvalidError('idempotencyKey');
  }
  return value;
}

/** Amounts arrive as canonical decimal strings; never a float. */
function ensureAmount(value: unknown): string {
  if (typeof value !== 'string' || !MONEY_PATTERN.test(value.trim())) {
    throw handymanCustomerPaymentInvalidError('amount');
  }
  const amount = value.trim();
  if (Number(amount) <= 0) {
    throw handymanCustomerPaymentInvalidError('amount');
  }
  return amount;
}

function ensureChannel(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!isHandymanCustomerPaymentChannel(raw)) {
    throw handymanCustomerPaymentInvalidError('channel');
  }
  return raw;
}

/** Bounded free text or explicit absence — never a provider enum. */
function ensureNeutralReference(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw handymanCustomerPaymentInvalidError(field);
  }
  const raw = value.trim();
  if (raw.length === 0 || raw.length > FREE_TEXT_MAX) {
    throw handymanCustomerPaymentInvalidError(field);
  }
  return raw;
}

/**
 * The CR-HM-13 client-access wall (same law as the ledger module):
 * an unknown scope is a bounded 404 (never fabricated) and an actor
 * without client access is a bounded 403. Caller-supplied identity is
 * never authority (§9.6).
 */
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
 * RECORD_PAYMENT: record one payment claim as `PENDING` against the
 * scope's ledger transaction. The amount is an external fact and is
 * therefore caller-supplied — but validated, never trusted: a
 * canonical positive decimal, in the TRANSACTION'S OWN currency
 * (cross-currency is structurally impossible; no FX exists here), on
 * a neutral channel, with bounded free-text references only. Replay
 * of the SAME key returns the SAME payment; a second payment reusing
 * an existing external reference on the same transaction is a bounded
 * 409 (§5.5).
 */
export async function recordHandymanCustomerPayment(
  input: RecordHandymanCustomerPaymentInput,
  actorUserId: string,
): Promise<HandymanCustomerPaymentCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);
  const amount = ensureAmount(input.amount);
  const channel = ensureChannel(input.channel);
  const providerName = ensureNeutralReference(
    input.providerName,
    'providerName',
  );
  const providerReference = ensureNeutralReference(
    input.providerReference,
    'providerReference',
  );
  const externalReference = ensureNeutralReference(
    input.externalReference,
    'externalReference',
  );

  const scope = await authorityPreamble(scopeUuid, actorUuid);

  try {
    return await withTransaction(async (tx) => {
      // Serialize every payment mutation of ONE ledger transaction on
      // that transaction's row: lookup-then-insert is atomic, so a
      // replayed key can never mint a second payment.
      const anchor = await tx.query(
        `SELECT id, client_id, currency, quotation_version_id
           FROM handyman_customer_transactions
          WHERE execution_scope_id = $1
          FOR UPDATE`,
        [scopeUuid],
      );
      const transaction = anchor.rows[0];
      if (!transaction) {
        throw handymanCustomerPaymentConflictError(
          'transaction-not-opened-for-execution-scope',
        );
      }
      const transactionId = transaction.id as string;
      const replayEvent = await handymanCustomerPaymentRepository
        .findPaymentEventByIdempotency(
          tx,
          transactionId,
          'RECORD_PAYMENT',
          key,
        );
      if (replayEvent) {
        const replayed = await handymanCustomerPaymentRepository
          .findPaymentById(tx, replayEvent.paymentId);
        if (!replayed) {
          throw handymanCustomerPaymentConflictError(
            'idempotency-key-bound-to-unknown-payment',
          );
        }
        return { payment: replayed, event: replayEvent, replayed: true };
      }
      // The payment currency is the ledger transaction's own; the
      // caller cannot introduce a second currency (no FX, I8).
      const currency = transaction.currency as string;
      const payment = await handymanCustomerPaymentRepository
        .insertPayment(tx, {
          clientId: transaction.client_id as string,
          transactionId,
          amount,
          currency,
          channel,
          providerName,
          providerReference,
          externalReference,
          recordedByUserId: actorUuid,
        });
      const event = await handymanCustomerPaymentRepository
        .appendPaymentEvent(tx, {
          clientId: payment.clientId,
          paymentId: payment.id,
          transactionId,
          eventType: 'RECORD_PAYMENT',
          idempotencyKey: key,
          actorUserId: actorUuid,
        });
      return { payment, event, replayed: false };
    });
  } catch (error) {
    const err = error as { code?: string; constraint?: string };
    if (err.code === PG_UNIQUE_VIOLATION) {
      if (
        !err.constraint
        || err.constraint.includes('external_ref')
      ) {
        // §5.5: an external reference is unique per transaction —
        // a duplicate notification/claim is fail-closed, never a
        // silently merged or duplicated payment fact.
        throw handymanCustomerPaymentConflictError(
          'external-reference-already-recorded',
        );
      }
      throw handymanCustomerPaymentConflictError(
        'idempotency-key-already-spent',
      );
    }
    throw error;
  }
}

type Decision = 'CONFIRMED' | 'REJECTED';

async function decide(
  input: ConfirmHandymanCustomerPaymentInput,
  actorUserId: string,
  decision: Decision,
  rejectionReason: string | null,
): Promise<HandymanCustomerPaymentCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const paymentUuid = ensureUuid(input.paymentId, 'paymentId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  await authorityPreamble(scopeUuid, actorUuid);

  return withTransaction(async (tx) => {
    const anchor = await tx.query(
      `SELECT id, client_id FROM handyman_customer_transactions
        WHERE execution_scope_id = $1
        FOR UPDATE`,
      [scopeUuid],
    );
    const transaction = anchor.rows[0];
    if (!transaction) {
      throw handymanCustomerPaymentConflictError(
        'transaction-not-opened-for-execution-scope',
      );
    }
    const transactionId = transaction.id as string;
    const current = await handymanCustomerPaymentRepository
      .findPaymentById(tx, paymentUuid, true);
    if (
      !current ||
      current.transactionId !== transactionId ||
      current.clientId !== (transaction.client_id as string)
    ) {
      // Cross-transaction / cross-client identity is never resolved
      // into a foreign payment fact: bounded 404 instead.
      throw handymanCustomerPaymentNotFoundError();
    }
    const eventType = decision === 'CONFIRMED'
      ? 'CONFIRM_PAYMENT'
      : 'REJECT_PAYMENT';
    const replayEvent = await handymanCustomerPaymentRepository
      .findPaymentEventByIdempotency(tx, transactionId, eventType, key);
    if (replayEvent) {
      if (replayEvent.paymentId !== current.id) {
        throw handymanCustomerPaymentConflictError(
          'idempotency-key-bound-to-another-payment',
        );
      }
      return { payment: current, event: replayEvent, replayed: true };
    }
    if (current.status !== 'PENDING') {
      // One authoritative transition per fact: a second decision is a
      // bounded conflict, never a silent re-decision (§9.4).
      throw handymanCustomerPaymentConflictError(
        `payment-already-decided-${current.status.toLowerCase()}`,
      );
    }
    const decided = await handymanCustomerPaymentRepository
      .decidePayment(tx, current.id, {
        status: decision,
        decidedByUserId: actorUuid,
        rejectionReason,
      });
    if (!decided) throw handymanCustomerPaymentNotFoundError();
    const event = await handymanCustomerPaymentRepository
      .appendPaymentEvent(tx, {
        clientId: decided.clientId,
        paymentId: decided.id,
        transactionId,
        eventType,
        idempotencyKey: key,
        actorUserId: actorUuid,
      });
    return { payment: decided, event, replayed: false };
  });
}

/**
 * CONFIRM_PAYMENT: the bounded server-side confirmation path that
 * turns a recorded claim into the AUTHORITATIVE received-funds fact
 * (§5.3). Only a `PENDING` payment can be confirmed; replay of the
 * same key returns the SAME decision; any second decision is a
 * bounded 409.
 */
export async function confirmHandymanCustomerPayment(
  input: ConfirmHandymanCustomerPaymentInput,
  actorUserId: string,
): Promise<HandymanCustomerPaymentCommandResult> {
  return decide(input, actorUserId, 'CONFIRMED', null);
}

/**
 * REJECT_PAYMENT: the bounded terminal outcome of a claim that must
 * not become authoritative received funds. A bounded reason is
 * required (1–200 chars). The rejected payment keeps its amount and
 * identity forever — the ledger never rewrites history (§7.1).
 */
export async function rejectHandymanCustomerPayment(
  input: RejectHandymanCustomerPaymentInput,
  actorUserId: string,
): Promise<HandymanCustomerPaymentCommandResult> {
  const reason = ensureNeutralReference(input.reason, 'reason');
  if (reason === null) {
    throw handymanCustomerPaymentInvalidError('reason');
  }
  return decide(input, actorUserId, 'REJECTED', reason);
}

/** Bounded internal read (the published contract is PART 06). */
export async function listHandymanCustomerPayments(
  executionScopeId: string,
  actorUserId: string,
): Promise<HandymanCustomerPaymentRecord[]> {
  const scopeUuid = ensureUuid(executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  await authorityPreamble(scopeUuid, actorUuid);
  const anchor = await getPool().query(
    `SELECT id FROM handyman_customer_transactions
      WHERE execution_scope_id = $1`,
    [scopeUuid],
  );
  const transactionId = anchor.rows[0]?.id as string | undefined;
  if (!transactionId) {
    // No ledger transaction exists for this scope: a payment read is
    // bounded, never fabricated.
    throw handymanCustomerTransactionNotFoundError();
  }
  return handymanCustomerPaymentRepository.listPaymentsByTransaction(
    undefined,
    transactionId,
  );
}

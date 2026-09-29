import { withTransaction } from '../../database';
import { isValidUuid } from '../clients';
import { contextAccessService } from '../context-access';
import {
  handymanExecutionScopeRepository,
  handymanQuotationLineRepository,
  type HandymanQuotationLineRecord,
} from '../handyman-quotations';
import type {
  HandymanCustomerTransactionCurrency,
} from './handyman-customer-transaction.types';
import {
  handymanCustomerTransactionBasisInvalidError,
  handymanCustomerTransactionConflictError,
  handymanCustomerTransactionNotAuthorizedError,
  handymanCustomerTransactionScopeNotFoundError,
  handymanCustomerTransactionValidationError,
} from './handyman-customer-transaction.errors';
import { handymanCustomerTransactionRepository }
  from './handyman-customer-transaction.repository';
import type {
  HandymanChargeLineCommandResult,
  HandymanCustomerTransactionCommandResult,
  OpenHandymanCustomerTransactionInput,
  PostHandymanChargeLineInput,
} from './handyman-customer-transaction.types';

/**
 * CR-HM-13 PART 01 — OPEN_TRANSACTION + POST_CHARGE_LINE commands ONLY
 * (FROZEN governance `CR-HM-13_START_GOVERNANCE.md` §3/§4/§8/§9, §10
 * row 01, §13 row 01).
 *
 * Composition of EXISTING authorities ONLY, read-only: CR-HM-06
 * AUTHORIZED execution scope + its immutable approved quotation version
 * and line snapshots (the amount authority), behind the shared
 * client-access wall. ZERO charge composition (no CR-HM-09 quantity
 * settlement, no CR-HM-12 basis-fact evaluation — PART 02), ZERO
 * payment/allocation/refund/reversal/adjustment (PART 03+), ZERO
 * provider/gateway surface, ZERO entitlement/settlement, ZERO HTTP.
 *
 * Authority law applied here:
 * - exactly ONE transaction per execution scope (§4.2 / I9);
 * - a charge line carries the immutable snapshot's OWN facts — the
 *   caller supplies no amount, kind, or currency (§4.3, §4.7);
 * - LABOR and MATERIAL stay separate rows, never merged (§4.5 / I13);
 * - every mutation is one transaction + row lock + single-use
 *   idempotency key (§9), replay returning the SAME rows.
 */

const PG_UNIQUE_VIOLATION = '23505';

function ensureUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw handymanCustomerTransactionValidationError(field);
  }
  return value;
}

function ensureKey(value: string): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > 200
  ) {
    throw handymanCustomerTransactionValidationError('idempotencyKey');
  }
  return value;
}

/**
 * PART 01 authority preamble: the scope must exist (client-bounded 404)
 * and the actor must hold client access (403). Caller-supplied
 * customer/actor identity is never authority. Later PARTs may add
 * further actor requirements; PART 01 does not invent one.
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
 * Fail-closed derivation of the ledger's ONE currency from the scope's
 * immutable approved quotation version: at least one snapshot line must
 * exist and every line must share the same currency (no implicit
 * conversion, no silent default — §4.5/§6.4).
 */
function deriveVersionCurrency(
  lines: HandymanQuotationLineRecord[],
): HandymanCustomerTransactionCurrency {
  if (lines.length === 0) {
    throw handymanCustomerTransactionBasisInvalidError(
      'approved-quotation-version-has-no-lines',
    );
  }
  const currencies = new Set(lines.map((line) => line.currency));
  if (currencies.size !== 1) {
    throw handymanCustomerTransactionBasisInvalidError(
      'approved-quotation-version-currency-drift',
    );
  }
  return lines[0].currency as HandymanCustomerTransactionCurrency;
}

/**
 * OPEN_TRANSACTION: create the SINGLE immutable transaction anchor for
 * an AUTHORIZED execution scope, server-deriving client / approved
 * quotation version / currency. Replay of the SAME idempotency key
 * returns the SAME transaction + event; a NEW key once a transaction
 * exists is a bounded 409 (never a second ledger).
 */
export async function openHandymanCustomerTransaction(
  input: OpenHandymanCustomerTransactionInput,
  actorUserId: string,
): Promise<HandymanCustomerTransactionCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  const scope = await authorityPreamble(scopeUuid, actorUuid);
  const lines = await handymanQuotationLineRepository.listLines(
    undefined,
    scope.approvedQuotationVersionId,
  );
  const currency = deriveVersionCurrency(lines);

  try {
    return await withTransaction(async (tx) => {
      // Serialize concurrent opens for the SAME execution scope.
      await tx.query(
        `SELECT id FROM handyman_execution_scopes WHERE id = $1
          FOR UPDATE`,
        [scopeUuid],
      );
      const existing = await handymanCustomerTransactionRepository
        .findTransactionByExecutionScopeId(tx, scopeUuid);
      if (existing) {
        const replayEvent = await handymanCustomerTransactionRepository
          .findTransactionEventByIdempotency(
            tx,
            existing.id,
            'OPEN_TRANSACTION',
            key,
          );
        if (replayEvent) {
          return { transaction: existing, event: replayEvent, replayed: true };
        }
        throw handymanCustomerTransactionConflictError(
          'transaction-already-exists-for-execution-scope',
        );
      }
      const transaction = await handymanCustomerTransactionRepository
        .createTransaction(tx, {
          clientId: scope.clientId,
          executionScopeId: scopeUuid,
          quotationVersionId: scope.approvedQuotationVersionId,
          currency,
          createdByUserId: actorUuid,
        });
      const event = await handymanCustomerTransactionRepository
        .appendTransactionEvent(tx, {
          clientId: scope.clientId,
          transactionId: transaction.id,
          chargeLineId: null,
          eventType: 'OPEN_TRANSACTION',
          idempotencyKey: key,
          actorUserId: actorUuid,
        });
      return { transaction, event, replayed: false };
    });
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === PG_UNIQUE_VIOLATION) {
      // UNIQUE (execution_scope_id) is the one-transaction law backstop.
      throw handymanCustomerTransactionConflictError(
        'transaction-already-exists-for-execution-scope',
      );
    }
    throw error;
  }
}

/**
 * POST_CHARGE_LINE: post ONE immutable charge line for a quotation line
 * of the transaction's anchored approved version. The line's kind,
 * amount, and currency are COPIED from the immutable snapshot line
 * (callers pass no commercial values); LABOR/MATERIAL stay separate.
 * Replay of the SAME key returns the SAME line + event; a new key for
 * an already-posted quotation line is a bounded 409 (one post per line).
 */
export async function postHandymanChargeLine(
  input: PostHandymanChargeLineInput,
  actorUserId: string,
): Promise<HandymanChargeLineCommandResult> {
  const scopeUuid = ensureUuid(input.executionScopeId, 'executionScopeId');
  const quoteLineUuid = ensureUuid(
    input.quotationLineId,
    'quotationLineId',
  );
  const actorUuid = ensureUuid(actorUserId, 'actorUserId');
  const key = ensureKey(input.idempotencyKey);

  const scope = await authorityPreamble(scopeUuid, actorUuid);
  const lines = await handymanQuotationLineRepository.listLines(
    undefined,
    scope.approvedQuotationVersionId,
  );
  const quoteLine = lines.find((line) => line.id === quoteLineUuid);
  if (!quoteLine) {
    // The charge basis MUST be a line of the scope's anchored approved
    // quotation version — never an arbitrary or pending snapshot.
    throw handymanCustomerTransactionBasisInvalidError(
      'line-not-on-approved-quotation-version',
    );
  }
  if (
    typeof quoteLine.lineTotal !== 'number' ||
    !Number.isFinite(quoteLine.lineTotal) ||
    quoteLine.lineTotal < 0
  ) {
    throw handymanCustomerTransactionBasisInvalidError(
      'snapshot-line-amount-not-usable',
    );
  }
  // Canonical NUMERIC(18,2) decimal string — no float arithmetic.
  const amount = quoteLine.lineTotal.toFixed(2);

  return withTransaction(async (tx) => {
    const transaction = await handymanCustomerTransactionRepository
      .findTransactionByExecutionScopeId(tx, scopeUuid, true);
    if (!transaction) {
      // A charge line never exists without its transaction anchor.
      throw handymanCustomerTransactionConflictError(
        'transaction-not-opened-for-execution-scope',
      );
    }
    const replayEvent = await handymanCustomerTransactionRepository
      .findTransactionEventByIdempotency(
        tx,
        transaction.id,
        'POST_CHARGE_LINE',
        key,
      );
    if (replayEvent) {
      const replayedLine = await handymanCustomerTransactionRepository
        .findChargeLineByQuotationLine(tx, transaction.id, quoteLineUuid);
      if (!replayedLine) {
        throw handymanCustomerTransactionConflictError(
          'idempotency-key-bound-to-unknown-charge-line',
        );
      }
      return {
        transaction,
        chargeLine: replayedLine,
        event: replayEvent,
        replayed: true,
      };
    }
    const existingLine = await handymanCustomerTransactionRepository
      .findChargeLineByQuotationLine(tx, transaction.id, quoteLineUuid);
    if (existingLine) {
      // One charge line per quotation line: a second post is a bounded
      // conflict, never a second row (corrections are PART 05 facts).
      throw handymanCustomerTransactionConflictError(
        'charge-line-already-posted-for-quotation-line',
      );
    }
    try {
      const chargeLine = await handymanCustomerTransactionRepository
        .insertChargeLine(tx, {
          clientId: transaction.clientId,
          transactionId: transaction.id,
          quotationLineId: quoteLine.id,
          lineKind: quoteLine.lineType,
          currency: quoteLine.currency,
          amount,
          createdByUserId: actorUuid,
        });
      const event = await handymanCustomerTransactionRepository
        .appendTransactionEvent(tx, {
          clientId: transaction.clientId,
          transactionId: transaction.id,
          chargeLineId: chargeLine.id,
          eventType: 'POST_CHARGE_LINE',
          idempotencyKey: key,
          actorUserId: actorUuid,
        });
      return { transaction, chargeLine, event, replayed: false };
    } catch (error) {
      const err = error as { code?: string };
      if (err.code === PG_UNIQUE_VIOLATION) {
        throw handymanCustomerTransactionConflictError(
          'charge-line-already-posted-for-quotation-line',
        );
      }
      throw error;
    }
  });
}

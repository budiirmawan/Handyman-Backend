import { withTransaction } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
import {
  handymanExecutionScopeRepository,
  handymanQuotationLineRepository,
  type HandymanQuotationLineRecord,
} from '../handyman-quotations';
import {
  readHandymanMaterialPricingCompositionAt,
  readHandymanPricingContractAt,
  type HandymanPricingContract,
} from '../handyman-pricing-contract';
import type {
  HandymanChargeBasisFactKind,
  HandymanChargeCompositionKind,
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
  ComposeHandymanChargeLineInput,
  HandymanChargeLineCommandResult,
  HandymanCustomerTransactionCommandResult,
  OpenHandymanCustomerTransactionInput,
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
 * and the actor must hold access to the scope's exact Building (403).
 * Caller-supplied customer/actor identity is never authority. Later
 * PARTs may add further actor requirements; PART 01 does not invent one.
 */
async function authorityPreamble(scopeUuid: string, actorUserId: string) {
  const scope = await handymanExecutionScopeRepository.findScopeById(
    undefined,
    scopeUuid,
  );
  if (!scope) throw handymanCustomerTransactionScopeNotFoundError();
  // CR-HM-SEC-01 PART 06E-1 — BE-02G exact-Building check on the
  // authoritative server-derived scope building (migration 0395),
  // replacing the client-level canAccessClient shortcut: a same-Client
  // sibling Building assignment must not open the ledger. The module's
  // denial vocabulary (403 HANDYMAN_CUSTOMER_TRANSACTION_NOT_AUTHORIZED)
  // and error precedence (scope 404 precedes the access wall) are
  // unchanged.
  if (!(await canAccessBuildingScopedResource(actorUserId, {
    clientId: scope.clientId,
    buildingId: scope.buildingId,
  }))) {
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
 * PART 02 — CHARGE COMPOSITION resolution from governed READ-ONLY
 * inputs (`CR-HM-13_START_GOVERNANCE.md` §10 row 02, §13 row 02):
 *
 * - LABOR composes to EXACTLY the customer-approved snapshot amount.
 *   A CR-HM-12 basis fact is recorded as the version anchor, never as
 *   a repricing input (§4.1/B4): the approved amount is the only
 *   lawful labor authority this PART has (no time ingestion exists
 *   here, and no per-row mode selection exists either, so
 *   `labor_basis_row_id` stays explicitly NULL).
 * - MATERIAL composes to the approved snapshot amount UNLESS an
 *   effective CR-HM-12 agreement version defines a MATERIAL basis:
 *   then the governed quantity mode (SETTLED_USAGE / APPROVED_QTY)
 *   decides, resolved through CR-HM-12's published scope composition
 *   over the CR-HM-09 FINAL_CHARGE_READY settled quantities. The unit
 *   amount is ALWAYS the immutable snapshot unit amount, the composed
 *   amount never exceeds the approved amount, and an unresolvable
 *   governed basis is a bounded failure — never a silent fallback to
 *   the approved amount.
 *
 * The composition instant is server-derived (`Date.now()`), never
 * caller-supplied: a caller cannot backdate a charge into an older
 * agreement version (B7 fail-closed as-of).
 */

function bindingOf(contract: HandymanPricingContract | null) {
  return {
    agreementId: contract?.binding.agreementId ?? null,
    agreementVersionId: contract?.binding.agreementVersionId ?? null,
    agreementVersionNumber: contract?.binding.versionNumber ?? null,
  };
}

/** The absence of a governed commercial context is explicit, never an
 * error swallowed silently: it maps to the snapshot-only basis kinds. */
function isNoEffectiveCommercialContext(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code ===
      ERROR_CODES.HANDYMAN_COMMERCIAL_AGREEMENT_NOT_EFFECTIVE_AT_AS_OF
  );
}

/** NUMERIC(14,3) precision guard — a quantity the ledger cannot carry
 * exactly is a bounded failure, never a rounded amount. */
function quantityText(value: number, field: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw handymanCustomerTransactionBasisInvalidError(field);
  }
  const text = value.toFixed(3);
  if (Number(text) !== value) {
    throw handymanCustomerTransactionBasisInvalidError(
      'quantity-exceeds-ledger-precision',
    );
  }
  return text;
}

function moneyText(value: number, field: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw handymanCustomerTransactionBasisInvalidError(field);
  }
  return value.toFixed(2);
}

type ChargeComposition = {
  compositionKind: HandymanChargeCompositionKind;
  basisFactKind: HandymanChargeBasisFactKind;
  appliedQty: string;
  unitAmount: string;
  amount: string;
  agreementId: string | null;
  agreementVersionId: string | null;
  agreementVersionNumber: number | null;
  laborBasisRowId: string | null;
  materialBasisRowId: string | null;
};

async function resolveChargeComposition(
  scope: { id: string; clientId: string },
  quoteLine: HandymanQuotationLineRecord,
  actorUserId: string,
  now: Date,
): Promise<ChargeComposition> {
  const snapshotUnitAmount = moneyText(
    quoteLine.finalQuotedUnitAmount,
    'snapshot-unit-amount-not-usable',
  );
  const snapshotAmount = moneyText(
    quoteLine.lineTotal,
    'snapshot-line-amount-not-usable',
  );
  const snapshotQty = quantityText(
    quoteLine.quantity,
    'snapshot-quantity-not-usable',
  );

  let contract: HandymanPricingContract | null = null;
  try {
    contract = await readHandymanPricingContractAt(
      scope.clientId,
      now.toISOString(),
    );
  } catch (error) {
    if (!isNoEffectiveCommercialContext(error)) throw error;
    contract = null;
  }
  const binding = bindingOf(contract);

  if (quoteLine.lineType === 'LABOR') {
    return {
      compositionKind: 'LABOR_APPROVED_SNAPSHOT',
      basisFactKind: contract
        ? 'CR_HM_12_BASIS_FACT'
        : 'CR_HM_06_APPROVED_SNAPSHOT',
      appliedQty: snapshotQty,
      unitAmount: snapshotUnitAmount,
      amount: snapshotAmount,
      ...binding,
      laborBasisRowId: null,
      materialBasisRowId: null,
    };
  }

  if (!contract || contract.materialBasis === null) {
    // No governed quantity mode is in force for this client as-of the
    // composition instant: the approved snapshot amount is the charge,
    // and the anchor SAYS SO explicitly (fact kind + null basis row).
    return {
      compositionKind: 'MATERIAL_APPROVED_SNAPSHOT',
      basisFactKind: contract
        ? 'CR_HM_12_BASIS_FACT'
        : 'CR_HM_06_APPROVED_SNAPSHOT',
      appliedQty: snapshotQty,
      unitAmount: snapshotUnitAmount,
      amount: snapshotAmount,
      ...binding,
      laborBasisRowId: null,
      materialBasisRowId: null,
    };
  }

  // A governed quantity mode IS in force: the CR-HM-12 published scope
  // composition is mandatory and any gap is fail-closed.
  const composed = await readHandymanMaterialPricingCompositionAt(
    scope.clientId,
    scope.id,
    now.toISOString(),
    actorUserId,
  );
  if (
    composed.binding.agreementVersionId !==
    contract.binding.agreementVersionId
  ) {
    throw handymanCustomerTransactionBasisInvalidError(
      'material-composition-not-bound-to-effective-version',
    );
  }
  const composedLine = composed.composition.basis.lines.find(
    (line) => line.quotationLineId === quoteLine.id,
  );
  if (!composedLine) {
    throw handymanCustomerTransactionBasisInvalidError(
      'material-line-not-settled-in-governed-composition',
    );
  }
  if (composedLine.currency !== quoteLine.currency) {
    throw handymanCustomerTransactionBasisInvalidError(
      'material-composition-currency-drift',
    );
  }
  if (composedLine.finalQuotedUnitAmount !== snapshotUnitAmount) {
    throw handymanCustomerTransactionBasisInvalidError(
      'material-composition-unit-amount-drift',
    );
  }
  // Money law mirrored from CR-HM-12's cent-exact evaluator.
  const unitCents = Math.round(Number(snapshotUnitAmount) * 100);
  const expectedCents = Math.floor(unitCents * composedLine.appliedQty + 0.5);
  if (Math.round(Number(composedLine.basisAmount) * 100) !== expectedCents) {
    throw handymanCustomerTransactionBasisInvalidError(
      'material-composition-money-law',
    );
  }
  if (Number(composedLine.basisAmount) > Number(snapshotAmount)) {
    throw handymanCustomerTransactionBasisInvalidError(
      'material-composition-exceeds-approved-amount',
    );
  }
  const mode = composed.composition.mode;
  if (mode !== 'SETTLED_USAGE' && mode !== 'APPROVED_QTY') {
    throw handymanCustomerTransactionBasisInvalidError(
      'material-composition-mode-unknown',
    );
  }
  return {
    compositionKind:
      mode === 'SETTLED_USAGE'
        ? 'MATERIAL_SETTLED_USAGE'
        : 'MATERIAL_APPROVED_QTY',
    basisFactKind: 'CR_HM_12_BASIS_FACT',
    appliedQty: quantityText(
      composedLine.appliedQty,
      'material-composition-quantity-not-usable',
    ),
    unitAmount: composedLine.finalQuotedUnitAmount,
    amount: composedLine.basisAmount,
    ...binding,
    laborBasisRowId: null,
    materialBasisRowId: contract.materialBasis.basisRowId,
  };
}

/**
 * COMPOSE_CHARGE_LINE (PART 02; the PART 01 export name
 * `postHandymanChargeLine` is retained as an alias — one law, one
 * path): post ONE immutable charge line whose amount was composed
 * from governed read-only inputs, together with its composition
 * anchor. LABOR and MATERIAL stay separate rows; a charge line can
 * never exist without its anchor (DB-deferred law), and a second
 * charge line for the same quotation line is a bounded conflict.
 */
export async function composeHandymanChargeLine(
  input: ComposeHandymanChargeLineInput,
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
      const replayedBasis = await handymanCustomerTransactionRepository
        .findChargeLineBasisByChargeLineId(tx, replayedLine.id);
      if (!replayedBasis) {
        throw handymanCustomerTransactionBasisInvalidError(
          'charge-line-without-composition-anchor',
        );
      }
      return {
        transaction,
        chargeLine: replayedLine,
        basis: replayedBasis,
        event: replayEvent,
        replayed: true,
      };
    }
    const existingLine = await handymanCustomerTransactionRepository
      .findChargeLineByQuotationLine(tx, transaction.id, quoteLineUuid);
    if (existingLine) {
      // One charge line per quotation line: a second post is a bounded
      // conflict, never a second row (corrections are later-PART facts).
      throw handymanCustomerTransactionConflictError(
        'charge-line-already-posted-for-quotation-line',
      );
    }
    // Composition runs only on the fresh path: a replay returns the
    // PERSISTED anchor, never a recomputed one.
    const composition = await resolveChargeComposition(
      scope,
      quoteLine,
      actorUuid,
      new Date(),
    );
    try {
      const chargeLine = await handymanCustomerTransactionRepository
        .insertChargeLine(tx, {
          clientId: transaction.clientId,
          transactionId: transaction.id,
          quotationLineId: quoteLine.id,
          lineKind: quoteLine.lineType,
          currency: quoteLine.currency,
          amount: composition.amount,
          createdByUserId: actorUuid,
        });
      const basis = await handymanCustomerTransactionRepository
        .insertChargeLineBasis(tx, {
          clientId: transaction.clientId,
          transactionId: transaction.id,
          chargeLineId: chargeLine.id,
          quotationVersionId: transaction.quotationVersionId,
          quotationLineId: quoteLine.id,
          lineKind: quoteLine.lineType,
          compositionKind: composition.compositionKind,
          basisFactKind: composition.basisFactKind,
          currency: quoteLine.currency,
          appliedQty: composition.appliedQty,
          unitAmount: composition.unitAmount,
          amount: composition.amount,
          agreementId: composition.agreementId,
          agreementVersionId: composition.agreementVersionId,
          agreementVersionNumber: composition.agreementVersionNumber,
          laborBasisRowId: composition.laborBasisRowId,
          materialBasisRowId: composition.materialBasisRowId,
          idempotencyKey: key,
          actorUserId: actorUuid,
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
      return { transaction, chargeLine, basis, event, replayed: false };
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

/** PART 01 export name, retained: identical law and identical path. */
export const postHandymanChargeLine = composeHandymanChargeLine;

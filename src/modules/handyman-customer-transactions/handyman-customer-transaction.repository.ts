import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
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
} from './handyman-customer-transaction.types';

/**
 * CR-HM-13 PART 01 — customer transaction ledger repository. The ONLY
 * writer of `handyman_customer_transactions`, `handyman_charge_lines`,
 * and `handyman_customer_transaction_events`. ZERO composition,
 * payment, allocation, correction, entitlement, or settlement logic
 * exists at this boundary: this layer persists given SERVER-derived
 * facts only. All timestamps are DB-server clock — callers pass no
 * time. Amounts are NUMERIC(18,2) and are read back as canonical
 * decimal STRINGS (never floats).
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

const TRANSACTION_SELECT = `
  SELECT id, client_id, execution_scope_id, quotation_version_id,
         currency, created_by_user_id, created_at, updated_at
    FROM handyman_customer_transactions`;

const CHARGE_LINE_SELECT = `
  SELECT id, client_id, transaction_id, quotation_line_id, line_kind,
         currency, amount, created_by_user_id, created_at, updated_at
    FROM handyman_charge_lines`;

const CHARGE_LINE_BASIS_SELECT = `
  SELECT id, client_id, transaction_id, charge_line_id,
         quotation_version_id, quotation_line_id, line_kind,
         composition_kind, basis_fact_kind, currency, applied_qty,
         unit_amount, amount, agreement_id, agreement_version_id,
         agreement_version_number, labor_basis_row_id,
         material_basis_row_id, idempotency_key, actor_user_id,
         occurred_at, created_at
    FROM handyman_charge_line_bases`;

const EVENT_SELECT = `
  SELECT id, client_id, transaction_id, charge_line_id, event_type,
         idempotency_key, actor_user_id, occurred_at, created_at
    FROM handyman_customer_transaction_events`;

/** NUMERIC never becomes a float: canonical decimal string. */
function toAmount(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function mapTransaction(row: Row): HandymanCustomerTransactionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    executionScopeId: row.execution_scope_id,
    quotationVersionId: row.quotation_version_id,
    currency: row.currency as HandymanCustomerTransactionCurrency,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapChargeLine(row: Row): HandymanChargeLineRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    transactionId: row.transaction_id,
    quotationLineId: row.quotation_line_id,
    lineKind: row.line_kind as HandymanChargeLineKind,
    currency: row.currency as HandymanCustomerTransactionCurrency,
    amount: toAmount(row.amount),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapChargeLineBasis(row: Row): HandymanChargeLineBasisRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    transactionId: row.transaction_id,
    chargeLineId: row.charge_line_id,
    quotationVersionId: row.quotation_version_id,
    quotationLineId: row.quotation_line_id,
    lineKind: row.line_kind as HandymanChargeLineKind,
    compositionKind: row.composition_kind as HandymanChargeCompositionKind,
    basisFactKind: row.basis_fact_kind as HandymanChargeBasisFactKind,
    currency: row.currency as HandymanCustomerTransactionCurrency,
    appliedQty: toAmount(row.applied_qty),
    unitAmount: toAmount(row.unit_amount),
    amount: toAmount(row.amount),
    agreementId: row.agreement_id ?? null,
    agreementVersionId: row.agreement_version_id ?? null,
    agreementVersionNumber: row.agreement_version_number === null
      || row.agreement_version_number === undefined
      ? null
      : Number(row.agreement_version_number),
    laborBasisRowId: row.labor_basis_row_id ?? null,
    materialBasisRowId: row.material_basis_row_id ?? null,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

function mapEvent(row: Row): HandymanCustomerTransactionEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    transactionId: row.transaction_id,
    chargeLineId: row.charge_line_id ?? null,
    eventType: row.event_type as HandymanCustomerTransactionEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Creates the single transaction anchor for an execution scope.
 * `clientId`/`quotationVersionId`/`currency` are server-derived by the
 * command layer and additionally enforced by the scope-consistency
 * trigger; `UNIQUE (execution_scope_id)` is the one-transaction law.
 */
async function createTransaction(
  executor: Executor = getPool(),
  record: NewHandymanCustomerTransaction,
): Promise<HandymanCustomerTransactionRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_customer_transactions (
       id, client_id, execution_scope_id, quotation_version_id,
       currency, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, client_id, execution_scope_id, quotation_version_id,
               currency, created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.executionScopeId,
      record.quotationVersionId,
      record.currency,
      record.createdByUserId,
    ],
  );
  return mapTransaction(result.rows[0]);
}

async function findTransactionByExecutionScopeId(
  executor: Executor = getPool(),
  executionScopeId: string,
  forUpdate = false,
): Promise<HandymanCustomerTransactionRecord | null> {
  const result = await executor.query(
    `${TRANSACTION_SELECT} WHERE execution_scope_id = $1${
      forUpdate ? ' FOR UPDATE' : ''
    }`,
    [executionScopeId],
  );
  return result.rows[0] ? mapTransaction(result.rows[0]) : null;
}

async function findTransactionById(
  executor: Executor = getPool(),
  transactionId: string,
): Promise<HandymanCustomerTransactionRecord | null> {
  const result = await executor.query(
    `${TRANSACTION_SELECT} WHERE id = $1`,
    [transactionId],
  );
  return result.rows[0] ? mapTransaction(result.rows[0]) : null;
}

/** Posts one immutable charge line (facts copied from the snapshot). */
async function insertChargeLine(
  executor: Executor = getPool(),
  record: NewHandymanChargeLine,
): Promise<HandymanChargeLineRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_charge_lines (
       id, client_id, transaction_id, quotation_line_id, line_kind,
       currency, amount, created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, client_id, transaction_id, quotation_line_id,
               line_kind, currency, amount, created_by_user_id,
               created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.transactionId,
      record.quotationLineId,
      record.lineKind,
      record.currency,
      record.amount,
      record.createdByUserId,
    ],
  );
  return mapChargeLine(result.rows[0]);
}

async function findChargeLineByQuotationLine(
  executor: Executor = getPool(),
  transactionId: string,
  quotationLineId: string,
): Promise<HandymanChargeLineRecord | null> {
  const result = await executor.query(
    `${CHARGE_LINE_SELECT}
      WHERE transaction_id = $1 AND quotation_line_id = $2`,
    [transactionId, quotationLineId],
  );
  return result.rows[0] ? mapChargeLine(result.rows[0]) : null;
}

async function listChargeLines(
  executor: Executor = getPool(),
  transactionId: string,
): Promise<HandymanChargeLineRecord[]> {
  const result = await executor.query(
    `${CHARGE_LINE_SELECT}
      WHERE transaction_id = $1
      ORDER BY created_at ASC, id ASC`,
    [transactionId],
  );
  return result.rows.map(mapChargeLine);
}

/**
 * PART 02 — writes the immutable COMPOSITION ANCHOR of one charge
 * line. Exactly one anchor per charge line (UNIQUE); the DB defers
 * the "every charge line has an anchor" law to COMMIT.
 */
async function insertChargeLineBasis(
  executor: Executor = getPool(),
  record: NewHandymanChargeLineBasis,
): Promise<HandymanChargeLineBasisRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_charge_line_bases (
       id, client_id, transaction_id, charge_line_id,
       quotation_version_id, quotation_line_id, line_kind,
       composition_kind, basis_fact_kind, currency, applied_qty,
       unit_amount, amount, agreement_id, agreement_version_id,
       agreement_version_number, labor_basis_row_id,
       material_basis_row_id, idempotency_key, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               $12, $13, $14, $15, $16, $17, $18, $19, $20)
     RETURNING id, client_id, transaction_id, charge_line_id,
               quotation_version_id, quotation_line_id, line_kind,
               composition_kind, basis_fact_kind, currency, applied_qty,
               unit_amount, amount, agreement_id, agreement_version_id,
               agreement_version_number, labor_basis_row_id,
               material_basis_row_id, idempotency_key, actor_user_id,
               occurred_at, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.transactionId,
      record.chargeLineId,
      record.quotationVersionId,
      record.quotationLineId,
      record.lineKind,
      record.compositionKind,
      record.basisFactKind,
      record.currency,
      record.appliedQty,
      record.unitAmount,
      record.amount,
      record.agreementId,
      record.agreementVersionId,
      record.agreementVersionNumber,
      record.laborBasisRowId,
      record.materialBasisRowId,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapChargeLineBasis(result.rows[0]);
}

async function findChargeLineBasisByChargeLineId(
  executor: Executor = getPool(),
  chargeLineId: string,
): Promise<HandymanChargeLineBasisRecord | null> {
  const result = await executor.query(
    `${CHARGE_LINE_BASIS_SELECT} WHERE charge_line_id = $1`,
    [chargeLineId],
  );
  return result.rows[0] ? mapChargeLineBasis(result.rows[0]) : null;
}

async function appendTransactionEvent(
  executor: Executor = getPool(),
  record: NewHandymanCustomerTransactionEvent,
): Promise<HandymanCustomerTransactionEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_customer_transaction_events (
       id, client_id, transaction_id, charge_line_id, event_type,
       idempotency_key, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, client_id, transaction_id, charge_line_id,
               event_type, idempotency_key, actor_user_id,
               occurred_at, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.transactionId,
      record.chargeLineId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapEvent(result.rows[0]);
}

async function findTransactionEventByIdempotency(
  executor: Executor = getPool(),
  transactionId: string,
  eventType: HandymanCustomerTransactionEventType,
  idempotencyKey: string,
): Promise<HandymanCustomerTransactionEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE transaction_id = $1 AND event_type = $2
        AND idempotency_key = $3`,
    [transactionId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

export const handymanCustomerTransactionRepository = {
  createTransaction,
  findTransactionByExecutionScopeId,
  findTransactionById,
  insertChargeLine,
  findChargeLineByQuotationLine,
  listChargeLines,
  insertChargeLineBasis,
  findChargeLineBasisByChargeLineId,
  appendTransactionEvent,
  findTransactionEventByIdempotency,
};

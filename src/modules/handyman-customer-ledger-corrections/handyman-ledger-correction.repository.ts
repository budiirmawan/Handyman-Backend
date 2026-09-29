import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandymanLedgerCorrectionKind,
  HandymanLedgerCorrectionRecord,
  HandymanLedgerCorrectionSourceKind,
  NewHandymanLedgerCorrection,
} from './handyman-ledger-correction.types';

/**
 * CR-HM-13 PART 05 — corrections repository. The ONLY writer of
 * `handyman_ledger_corrections`. ZERO correction decision logic, ZERO
 * entitlement/settlement logic: this layer persists given
 * SERVER-validated forward-only facts only. All timestamps are
 * DB-server clock — callers pass no time. Amounts are NUMERIC(18,2)
 * read back as canonical decimal STRINGS (never floats).
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

const CORRECTION_SELECT = `
  SELECT id, client_id, transaction_id, correction_kind, source_kind,
         source_payment_id, source_allocation_id, source_charge_line_id,
         currency, amount, reason, corrected_by_user_id,
         idempotency_key, occurred_at, created_at
    FROM handyman_ledger_corrections`;

function toAmount(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function mapCorrection(row: Row): HandymanLedgerCorrectionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    transactionId: row.transaction_id,
    correctionKind: row.correction_kind as HandymanLedgerCorrectionKind,
    sourceKind: row.source_kind as HandymanLedgerCorrectionSourceKind,
    sourcePaymentId: row.source_payment_id ?? null,
    sourceAllocationId: row.source_allocation_id ?? null,
    sourceChargeLineId: row.source_charge_line_id ?? null,
    currency: row.currency,
    amount: toAmount(row.amount),
    reason: row.reason,
    correctedByUserId: row.corrected_by_user_id,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

async function insertCorrection(
  executor: Executor = getPool(),
  record: NewHandymanLedgerCorrection,
): Promise<HandymanLedgerCorrectionRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_ledger_corrections (
       id, client_id, transaction_id, correction_kind, source_kind,
       source_payment_id, source_allocation_id, source_charge_line_id,
       currency, amount, reason, corrected_by_user_id, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, client_id, transaction_id, correction_kind,
               source_kind, source_payment_id, source_allocation_id,
               source_charge_line_id, currency, amount, reason,
               corrected_by_user_id, idempotency_key, occurred_at,
               created_at`,
    [
      randomUUID(),
      record.clientId,
      record.transactionId,
      record.correctionKind,
      record.sourceKind,
      record.sourcePaymentId,
      record.sourceAllocationId,
      record.sourceChargeLineId,
      record.currency,
      record.amount,
      record.reason,
      record.correctedByUserId,
      record.idempotencyKey,
    ],
  );
  return mapCorrection(result.rows[0]);
}

async function findCorrectionByKey(
  executor: Executor = getPool(),
  transactionId: string,
  idempotencyKey: string,
): Promise<HandymanLedgerCorrectionRecord | null> {
  const result = await executor.query(
    `${CORRECTION_SELECT}
      WHERE transaction_id = $1 AND idempotency_key = $2`,
    [transactionId, idempotencyKey],
  );
  return result.rows[0] ? mapCorrection(result.rows[0]) : null;
}

async function listCorrectionsByTransaction(
  executor: Executor = getPool(),
  transactionId: string,
): Promise<HandymanLedgerCorrectionRecord[]> {
  const result = await executor.query(
    `${CORRECTION_SELECT}
      WHERE transaction_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [transactionId],
  );
  return result.rows.map(mapCorrection);
}

export const handymanLedgerCorrectionRepository = {
  insertCorrection,
  findCorrectionByKey,
  listCorrectionsByTransaction,
};

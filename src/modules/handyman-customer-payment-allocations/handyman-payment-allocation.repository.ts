import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandymanPaymentAllocationRecord,
  NewHandymanPaymentAllocation,
} from './handyman-payment-allocation.types';

/**
 * CR-HM-13 PART 04 — allocation repository. The ONLY writer of
 * `handyman_payment_allocations`. ZERO lifecycle/allocation decision
 * logic, ZERO refund/reversal/adjustment, ZERO entitlement/settlement
 * logic: this layer persists given SERVER-validated facts only. All
 * timestamps are DB-server clock — callers pass no time. Amounts are
 * NUMERIC(18,2) read back as canonical decimal STRINGS (never floats).
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

const ALLOCATION_SELECT = `
  SELECT id, client_id, transaction_id, payment_id, charge_line_id,
         line_kind, currency, amount, allocated_by_user_id,
         idempotency_key, occurred_at, created_at
    FROM handyman_payment_allocations`;

function toAmount(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function mapAllocation(row: Row): HandymanPaymentAllocationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    transactionId: row.transaction_id,
    paymentId: row.payment_id,
    chargeLineId: row.charge_line_id,
    lineKind: row.line_kind as 'LABOR' | 'MATERIAL',
    currency: row.currency,
    amount: toAmount(row.amount),
    allocatedByUserId: row.allocated_by_user_id,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

async function insertAllocation(
  executor: Executor = getPool(),
  record: NewHandymanPaymentAllocation,
): Promise<HandymanPaymentAllocationRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_payment_allocations (
       id, client_id, transaction_id, payment_id, charge_line_id,
       line_kind, currency, amount, allocated_by_user_id,
       idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, client_id, transaction_id, payment_id,
               charge_line_id, line_kind, currency, amount,
               allocated_by_user_id, idempotency_key, occurred_at,
               created_at`,
    [
      randomUUID(),
      record.clientId,
      record.transactionId,
      record.paymentId,
      record.chargeLineId,
      record.lineKind,
      record.currency,
      record.amount,
      record.allocatedByUserId,
      record.idempotencyKey,
    ],
  );
  return mapAllocation(result.rows[0]);
}

async function findAllocationByKey(
  executor: Executor = getPool(),
  transactionId: string,
  idempotencyKey: string,
): Promise<HandymanPaymentAllocationRecord | null> {
  const result = await executor.query(
    `${ALLOCATION_SELECT}
      WHERE transaction_id = $1 AND idempotency_key = $2`,
    [transactionId, idempotencyKey],
  );
  return result.rows[0] ? mapAllocation(result.rows[0]) : null;
}

async function listAllocationsByTransaction(
  executor: Executor = getPool(),
  transactionId: string,
): Promise<HandymanPaymentAllocationRecord[]> {
  const result = await executor.query(
    `${ALLOCATION_SELECT}
      WHERE transaction_id = $1
      ORDER BY occurred_at ASC, id ASC`,
    [transactionId],
  );
  return result.rows.map(mapAllocation);
}

/**
 * Sum of allocations for one payment / one charge line. NUMERIC
 * arithmetic happens in SQL; the value crosses the boundary as a
 * canonical decimal string and is compared in integer cents.
 */
async function sumAllocatedForPayment(
  executor: Executor = getPool(),
  paymentId: string,
): Promise<string> {
  const result = await executor.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric(18, 2)::text AS total
       FROM handyman_payment_allocations WHERE payment_id = $1`,
    [paymentId],
  );
  return toAmount(result.rows[0].total);
}

async function sumAllocatedForChargeLine(
  executor: Executor = getPool(),
  chargeLineId: string,
): Promise<string> {
  const result = await executor.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric(18, 2)::text AS total
       FROM handyman_payment_allocations WHERE charge_line_id = $1`,
    [chargeLineId],
  );
  return toAmount(result.rows[0].total);
}

export const handymanPaymentAllocationRepository = {
  insertAllocation,
  findAllocationByKey,
  listAllocationsByTransaction,
  sumAllocatedForPayment,
  sumAllocatedForChargeLine,
};

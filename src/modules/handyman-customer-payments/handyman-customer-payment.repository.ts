import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  HandymanCustomerPaymentChannel,
  HandymanCustomerPaymentEventRecord,
  HandymanCustomerPaymentEventType,
  HandymanCustomerPaymentRecord,
  HandymanCustomerPaymentStatus,
  NewHandymanCustomerPayment,
  NewHandymanCustomerPaymentEvent,
} from './handyman-customer-payment.types';

/**
 * CR-HM-13 PART 03 — payment repository. The ONLY writer of
 * `handyman_customer_payments` and
 * `handyman_customer_payment_events`. ZERO lifecycle decision logic,
 * ZERO allocation, ZERO refund/reversal/adjustment, ZERO
 * entitlement/settlement logic: this layer persists given
 * SERVER-derived facts only. All timestamps are DB-server clock —
 * callers pass no time. Amounts are NUMERIC(18,2) read back as
 * canonical decimal STRINGS (never floats).
 */

type Row = QueryResultRow;
type Executor = Pick<PoolClient, 'query'>;

const PAYMENT_SELECT = `
  SELECT id, client_id, transaction_id, status, amount, currency,
         channel, provider_name, provider_reference, external_reference,
         received_at, recorded_by_user_id, decided_at,
         decided_by_user_id, rejection_reason, created_at
    FROM handyman_customer_payments`;

const EVENT_SELECT = `
  SELECT id, client_id, payment_id, transaction_id, event_type,
         idempotency_key, actor_user_id, occurred_at, created_at
    FROM handyman_customer_payment_events`;

/** NUMERIC never becomes a float: canonical decimal string. */
function toAmount(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function mapPayment(row: Row): HandymanCustomerPaymentRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    transactionId: row.transaction_id,
    status: row.status as HandymanCustomerPaymentStatus,
    amount: toAmount(row.amount),
    currency: row.currency,
    channel: row.channel as HandymanCustomerPaymentChannel,
    providerName: row.provider_name ?? null,
    providerReference: row.provider_reference ?? null,
    externalReference: row.external_reference ?? null,
    receivedAt: row.received_at.toISOString(),
    recordedByUserId: row.recorded_by_user_id,
    decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    decidedByUserId: row.decided_by_user_id ?? null,
    rejectionReason: row.rejection_reason ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function mapEvent(row: Row): HandymanCustomerPaymentEventRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    paymentId: row.payment_id,
    transactionId: row.transaction_id,
    eventType: row.event_type as HandymanCustomerPaymentEventType,
    idempotencyKey: row.idempotency_key,
    actorUserId: row.actor_user_id,
    occurredAt: row.occurred_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Records ONE payment fact. It always enters as `PENDING` (the DB
 * guard refuses any other entry state): a recorded claim is never
 * authoritative received funds by itself (§5.3).
 */
async function insertPayment(
  executor: Executor = getPool(),
  record: NewHandymanCustomerPayment,
): Promise<HandymanCustomerPaymentRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_customer_payments (
       id, client_id, transaction_id, status, amount, currency, channel,
       provider_name, provider_reference, external_reference,
       recorded_by_user_id
     ) VALUES ($1, $2, $3, 'PENDING', $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, client_id, transaction_id, status, amount, currency,
               channel, provider_name, provider_reference,
               external_reference, received_at, recorded_by_user_id,
               decided_at, decided_by_user_id, rejection_reason,
               created_at`,
    [
      randomUUID(),
      record.clientId,
      record.transactionId,
      record.amount,
      record.currency,
      record.channel,
      record.providerName,
      record.providerReference,
      record.externalReference,
      record.recordedByUserId,
    ],
  );
  return mapPayment(result.rows[0]);
}

async function findPaymentById(
  executor: Executor = getPool(),
  paymentId: string,
  forUpdate = false,
): Promise<HandymanCustomerPaymentRecord | null> {
  const result = await executor.query(
    `${PAYMENT_SELECT} WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    [paymentId],
  );
  return result.rows[0] ? mapPayment(result.rows[0]) : null;
}

async function listPaymentsByTransaction(
  executor: Executor = getPool(),
  transactionId: string,
): Promise<HandymanCustomerPaymentRecord[]> {
  const result = await executor.query(
    `${PAYMENT_SELECT} WHERE transaction_id = $1
      ORDER BY received_at ASC, id ASC`,
    [transactionId],
  );
  return result.rows.map(mapPayment);
}

/**
 * The ONE-way decision projection: `PENDING` -> `CONFIRMED` |
 * `REJECTED`, with the decision actor and the DB clock. The DB guard
 * refuses every other update shape (including a second decision).
 */
async function decidePayment(
  executor: Executor = getPool(),
  paymentId: string,
  decision: {
    status: 'CONFIRMED' | 'REJECTED';
    decidedByUserId: string;
    rejectionReason: string | null;
  },
): Promise<HandymanCustomerPaymentRecord | null> {
  const result = await executor.query(
    `UPDATE handyman_customer_payments
        SET status = $2,
            decided_at = NOW(),
            decided_by_user_id = $3,
            rejection_reason = $4
      WHERE id = $1
      RETURNING id, client_id, transaction_id, status, amount, currency,
                channel, provider_name, provider_reference,
                external_reference, received_at, recorded_by_user_id,
                decided_at, decided_by_user_id, rejection_reason,
                created_at`,
    [
      paymentId,
      decision.status,
      decision.decidedByUserId,
      decision.rejectionReason,
    ],
  );
  return result.rows[0] ? mapPayment(result.rows[0]) : null;
}

async function appendPaymentEvent(
  executor: Executor = getPool(),
  record: NewHandymanCustomerPaymentEvent,
): Promise<HandymanCustomerPaymentEventRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_customer_payment_events (
       id, client_id, payment_id, transaction_id, event_type,
       idempotency_key, actor_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, client_id, payment_id, transaction_id, event_type,
               idempotency_key, actor_user_id, occurred_at, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.paymentId,
      record.transactionId,
      record.eventType,
      record.idempotencyKey,
      record.actorUserId,
    ],
  );
  return mapEvent(result.rows[0]);
}

async function findPaymentEventByIdempotency(
  executor: Executor = getPool(),
  transactionId: string,
  eventType: HandymanCustomerPaymentEventType,
  idempotencyKey: string,
): Promise<HandymanCustomerPaymentEventRecord | null> {
  const result = await executor.query(
    `${EVENT_SELECT}
      WHERE transaction_id = $1 AND event_type = $2
        AND idempotency_key = $3`,
    [transactionId, eventType, idempotencyKey],
  );
  return result.rows[0] ? mapEvent(result.rows[0]) : null;
}

export const handymanCustomerPaymentRepository = {
  insertPayment,
  findPaymentById,
  listPaymentsByTransaction,
  decidePayment,
  appendPaymentEvent,
  findPaymentEventByIdempotency,
};

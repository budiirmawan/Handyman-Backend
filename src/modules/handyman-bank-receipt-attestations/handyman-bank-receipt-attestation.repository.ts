import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { HandymanBankReceiptAttestationRecord } from './handyman-bank-receipt-attestation.types';

type Executor = Pick<PoolClient, 'query'>;

function mapRow(row: Record<string, unknown>): HandymanBankReceiptAttestationRecord {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    transactionId: String(row.transaction_id),
    paymentId: String(row.payment_id),
    destinationBankAccountId: String(row.destination_bank_account_id),
    bankTransactionId: String(row.bank_transaction_id),
    amountCredited: typeof row.amount_credited === 'string' ? row.amount_credited : String(row.amount_credited),
    currency: String(row.currency),
    bankCreditedAt: (row.bank_credited_at as Date).toISOString(),
    verifiedByUserId: String(row.verified_by_user_id),
    verifiedAt: (row.verified_at as Date).toISOString(),
    bankStatementEvidenceRef: row.bank_statement_evidence_ref ? String(row.bank_statement_evidence_ref) : null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

async function insertAttestation(
  executor: Executor,
  record: {
    clientId: string;
    transactionId: string;
    paymentId: string;
    destinationBankAccountId: string;
    bankTransactionId: string;
    amountCredited: string;
    currency: string;
    bankCreditedAt: string;
    verifiedByUserId: string;
    bankStatementEvidenceRef: string | null;
  },
): Promise<HandymanBankReceiptAttestationRecord> {
  const result = await executor.query(
    `INSERT INTO handyman_bank_receipt_attestations (
       id, client_id, transaction_id, payment_id, destination_bank_account_id,
       bank_transaction_id, amount_credited, currency, bank_credited_at,
       verified_by_user_id, verified_at, bank_statement_evidence_ref
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),$11)
     RETURNING id, client_id, transaction_id, payment_id, destination_bank_account_id,
               bank_transaction_id, amount_credited, currency, bank_credited_at,
               verified_by_user_id, verified_at, bank_statement_evidence_ref, created_at`,
    [
      randomUUID(),
      record.clientId,
      record.transactionId,
      record.paymentId,
      record.destinationBankAccountId,
      record.bankTransactionId,
      record.amountCredited,
      record.currency,
      record.bankCreditedAt,
      record.verifiedByUserId,
      record.bankStatementEvidenceRef,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findAttestationByPaymentId(
  executor: Executor = getPool(),
  paymentId: string,
): Promise<HandymanBankReceiptAttestationRecord | null> {
  const result = await executor.query(
    `SELECT id, client_id, transaction_id, payment_id, destination_bank_account_id,
            bank_transaction_id, amount_credited, currency, bank_credited_at,
            verified_by_user_id, verified_at, bank_statement_evidence_ref, created_at
       FROM handyman_bank_receipt_attestations WHERE payment_id = $1`,
    [paymentId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findAttestationByBankRef(
  executor: Executor = getPool(),
  clientId: string,
  bankTransactionId: string,
): Promise<HandymanBankReceiptAttestationRecord | null> {
  const result = await executor.query(
    `SELECT id, client_id, transaction_id, payment_id, destination_bank_account_id,
            bank_transaction_id, amount_credited, currency, bank_credited_at,
            verified_by_user_id, verified_at, bank_statement_evidence_ref, created_at
       FROM handyman_bank_receipt_attestations
      WHERE client_id = $1 AND bank_transaction_id = $2`,
    [clientId, bankTransactionId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const handymanBankReceiptAttestationRepository = {
  insertAttestation,
  findAttestationByPaymentId,
  findAttestationByBankRef,
};

/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01B — bank account persistence.
 *
 * Executor-first convention, exactly like the issuer-profile repository: every
 * function takes the executor as its FIRST argument (the shared pool by
 * default) so the service can run a whole command inside one transaction.
 *
 * There is no UPDATE path for the payment-critical columns anywhere in this file:
 * a content change INSERTS a new version row, and the only statements that write
 * are the lifecycle projections the 0491 trigger permits. Every statement here
 * therefore matches one, and only one, documented transition.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanDocumentBankAccountContent,
  HandymanDocumentBankAccountRecord,
  HandymanDocumentBankAccountStatus,
} from './handyman-document-bank.types';

export type BankAccountRow = HandymanDocumentBankAccountRecord & { isLatestVersion: boolean };

type RawRow = {
  id: string;
  client_id: string;
  bank_account_id: string;
  version: number;
  bank_code: string;
  bank_name: string;
  account_number: string;
  account_holder_name: string;
  currency: string;
  status: HandymanDocumentBankAccountStatus;
  is_default: boolean;
  verification_reference: string | null;
  verified_at: Date | null;
  verified_by_user_id: string | null;
  deactivated_at: Date | null;
  superseded_at: Date | null;
  effective_from: Date;
  created_by_user_id: string;
  created_at: Date;
  is_latest_version?: boolean;
};

const COLUMNS = `
  id, client_id, bank_account_id, version, bank_code, bank_name, account_number,
  account_holder_name, currency, status, is_default, verification_reference,
  verified_at, verified_by_user_id, deactivated_at, superseded_at, effective_from,
  created_by_user_id, created_at`;

function map(row: RawRow): BankAccountRow {
  return {
    id: row.id,
    clientId: row.client_id,
    bankAccountId: row.bank_account_id,
    version: row.version,
    bankCode: row.bank_code,
    bankName: row.bank_name,
    accountNumber: row.account_number,
    accountHolderName: row.account_holder_name,
    currency: row.currency,
    status: row.status,
    isDefault: row.is_default,
    verificationReference: row.verification_reference,
    verifiedAt: row.verified_at,
    verifiedByUserId: row.verified_by_user_id,
    deactivatedAt: row.deactivated_at,
    supersededAt: row.superseded_at,
    effectiveFrom: row.effective_from,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    isLatestVersion: row.is_latest_version === undefined
      ? true
      : Boolean(row.is_latest_version),
  };
}

/** Reads a chain's newest version (the row a writer must anchor on). */
export async function findLatestByBankAccount(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  bankAccountId: string,
): Promise<BankAccountRow | null> {
  const result = await executor.query<RawRow>(
    `SELECT ${COLUMNS}, (version = (MAX(version) OVER (PARTITION BY bank_account_id))) AS is_latest_version
       FROM handyman_document_issuer_bank_accounts
      WHERE client_id = $1 AND bank_account_id = $2
      ORDER BY version DESC
      LIMIT 1`,
    [clientId, bankAccountId],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

/**
 * Locks the chain's newest version. The provider-level lock is taken first by
 * the service, so this serializes every writer of one provider and one account
 * instead of racing the one-default-per-currency index.
 */
export async function lockLatestByBankAccount(
  tx: Pick<PoolClient, 'query'>,
  clientId: string,
  bankAccountId: string,
): Promise<BankAccountRow | null> {
  const result = await tx.query<RawRow>(
    `SELECT ${COLUMNS} FROM handyman_document_issuer_bank_accounts
      WHERE client_id = $1 AND bank_account_id = $2
      ORDER BY version DESC
      LIMIT 1
      FOR UPDATE`,
    [clientId, bankAccountId],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

/** The row that currently IS the payment destination for one currency. */
export async function findActiveDefault(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  currency: string,
): Promise<BankAccountRow | null> {
  const result = await executor.query<RawRow>(
    `SELECT ${COLUMNS} FROM handyman_document_issuer_bank_accounts
      WHERE client_id = $1 AND currency = $2 AND status = 'ACTIVE' AND is_default
      LIMIT 1`,
    [clientId, currency],
  );
  const row = result.rows[0];
  return row ? map(row) : null;
}

/** Every live state of every account of this provider (nothing superseded). */
export async function listLiveAccounts(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  filter: { currency: string | null; status: HandymanDocumentBankAccountStatus | null; limit: number },
): Promise<BankAccountRow[]> {
  const params: unknown[] = [clientId, filter.limit];
  let where = ` WHERE client_id = $1 AND status <> 'SUPERSEDED'`;
  if (filter.currency) {
    params.push(filter.currency);
    where += ` AND currency = $${params.length}`;
  }
  if (filter.status) {
    params.push(filter.status);
    where += ` AND status = $${params.length}`;
  }
  const result = await executor.query<RawRow>(
    `SELECT ${COLUMNS},
            (version = (MAX(version) OVER (PARTITION BY bank_account_id))) AS is_latest_version
       FROM handyman_document_issuer_bank_accounts${where}
      ORDER BY currency, bank_code, bank_account_id, version DESC
      LIMIT $2`,
    params,
  );
  return result.rows.map(map);
}

/** The full version chain of one account, newest first: history stays readable. */
export async function listHistory(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  bankAccountId: string,
  limit: number,
): Promise<BankAccountRow[]> {
  const result = await executor.query<RawRow>(
    `SELECT ${COLUMNS}, (version = (MAX(version) OVER (PARTITION BY bank_account_id))) AS is_latest_version
       FROM handyman_document_issuer_bank_accounts
      WHERE client_id = $1 AND bank_account_id = $2
      ORDER BY version DESC
      LIMIT $3`,
    [clientId, bankAccountId, limit],
  );
  return result.rows.map(map);
}

/** A new chain starts at version 1 with its own id as the chain identity. */
export async function insertAccount(
  tx: Pick<PoolClient, 'query'>,
  input: {
    clientId: string;
    createdByUserId: string;
    content: HandymanDocumentBankAccountContent;
    bankAccountId?: string;
    version?: number;
  },
): Promise<BankAccountRow> {
  const id = randomUUID();
  const version = input.version ?? 1;
  const result = await tx.query<RawRow>(
    `INSERT INTO handyman_document_issuer_bank_accounts
       (id, client_id, bank_account_id, version, bank_code, bank_name, account_number,
        account_holder_name, currency, status, is_default, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_VERIFICATION', FALSE, $10)
     RETURNING ${COLUMNS}`,
    [
      id,
      input.clientId,
      // version 1 IS the chain identity, so a document can cite the account
      // without knowing which version row carried it
      input.bankAccountId ?? id,
      version,
      input.content.bankCode,
      input.content.bankName,
      input.content.accountNumber,
      input.content.accountHolderName,
      input.content.currency,
      input.createdByUserId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Bank account insert returned no row.');
  return map(row);
}

/** PENDING_VERIFICATION -> ACTIVE: the verification act itself. */
export async function activatePending(
  tx: Pick<PoolClient, 'query'>,
  input: {
    id: string;
    verifiedByUserId: string;
    verificationReference: string;
    isDefault: boolean;
  },
): Promise<BankAccountRow> {
  const result = await tx.query<RawRow>(
    `UPDATE handyman_document_issuer_bank_accounts
        SET status = 'ACTIVE',
            is_default = $2,
            verification_reference = $3,
            verified_at = NOW(),
            verified_by_user_id = $4
      WHERE id = $1 AND status = 'PENDING_VERIFICATION'
      RETURNING ${COLUMNS}`,
    [input.id, input.isDefault, input.verificationReference, input.verifiedByUserId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Bank account verification matched no pending version.');
  return map(row);
}

/** SUSPENDED -> ACTIVE: the original verification is reused, never re-stamped. */
export async function reactivate(
  tx: Pick<PoolClient, 'query'>,
  input: { id: string; isDefault: boolean },
): Promise<BankAccountRow> {
  const result = await tx.query<RawRow>(
    `UPDATE handyman_document_issuer_bank_accounts
        SET status = 'ACTIVE', is_default = $2, deactivated_at = NULL
      WHERE id = $1 AND status = 'SUSPENDED'
      RETURNING ${COLUMNS}`,
    [input.id, input.isDefault],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Bank account reactivation matched no suspended version.');
  return map(row);
}

/** ACTIVE -> SUSPENDED: an explicit deactivation, losing the default flag. */
export async function suspend(
  tx: Pick<PoolClient, 'query'>,
  id: string,
): Promise<BankAccountRow> {
  const result = await tx.query<RawRow>(
    `UPDATE handyman_document_issuer_bank_accounts
        SET status = 'SUSPENDED', is_default = FALSE, deactivated_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'
      RETURNING ${COLUMNS}`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Bank account deactivation matched no active version.');
  return map(row);
}

/** The only retirement path: drop the default flag and timestamp it. */
export async function retire(
  tx: Pick<PoolClient, 'query'>,
  id: string,
): Promise<void> {
  await tx.query(
    `UPDATE handyman_document_issuer_bank_accounts
        SET status = 'SUPERSEDED', is_default = FALSE, superseded_at = NOW()
      WHERE id = $1 AND status IN ('ACTIVE', 'PENDING_VERIFICATION')`,
    [id],
  );
}

export const handymanDocumentBankAccountRepository = {
  findLatestByBankAccount,
  lockLatestByBankAccount,
  findActiveDefault,
  listLiveAccounts,
  listHistory,
  insertAccount,
  activatePending,
  reactivate,
  suspend,
  retire,
};

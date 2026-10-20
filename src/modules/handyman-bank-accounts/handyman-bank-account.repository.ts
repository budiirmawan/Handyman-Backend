import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { HandymanBankAccountRow } from './handyman-bank-account.types';

type Executor = Pick<PoolClient, 'query'>;

function mapRow(row: Record<string, unknown>): HandymanBankAccountRow {
  return {
    id: String(row.id),
    clientId: String(row.client_id),
    buildingId: row.building_id ? String(row.building_id) : null,
    bankName: String(row.bank_name),
    accountNumber: String(row.account_number),
    accountHolderName: String(row.account_holder_name),
    displayName: String(row.display_name),
    currency: String(row.currency),
    isActive: Boolean(row.is_active),
    createdByUserId: String(row.created_by_user_id),
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

async function insertBankAccount(
  executor: Executor = getPool(),
  record: {
    clientId: string;
    buildingId: string | null;
    bankName: string;
    accountNumber: string;
    accountHolderName: string;
    displayName: string;
    currency: string;
    createdByUserId: string;
  },
): Promise<HandymanBankAccountRow> {
  const result = await executor.query(
    `INSERT INTO handyman_bank_accounts (
       id, client_id, building_id, bank_name, account_number,
       account_holder_name, display_name, currency, is_active, created_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE,$9)
     RETURNING id, client_id, building_id, bank_name, account_number,
               account_holder_name, display_name, currency, is_active,
               created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      record.clientId,
      record.buildingId,
      record.bankName,
      record.accountNumber,
      record.accountHolderName,
      record.displayName,
      record.currency,
      record.createdByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

async function findBankAccountById(
  executor: Executor = getPool(),
  accountId: string,
): Promise<HandymanBankAccountRow | null> {
  const result = await executor.query(
    `SELECT id, client_id, building_id, bank_name, account_number,
            account_holder_name, display_name, currency, is_active,
            created_by_user_id, created_at, updated_at
       FROM handyman_bank_accounts WHERE id = $1`,
    [accountId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function listBankAccountsByClient(
  executor: Executor = getPool(),
  clientId: string,
  opts: { buildingId?: string | null; includeInactive?: boolean } = {},
): Promise<HandymanBankAccountRow[]> {
  const conditions: string[] = ['client_id = $1'];
  const params: unknown[] = [clientId];
  if (opts.buildingId !== undefined && opts.buildingId !== null) {
    conditions.push(`(building_id IS NULL OR building_id = $${params.length + 1})`);
    params.push(opts.buildingId);
  }
  if (!opts.includeInactive) {
    conditions.push(`is_active = TRUE`);
  }
  const result = await executor.query(
    `SELECT id, client_id, building_id, bank_name, account_number,
            account_holder_name, display_name, currency, is_active,
            created_by_user_id, created_at, updated_at
       FROM handyman_bank_accounts
      WHERE ${conditions.join(' AND ')}
      ORDER BY created_at ASC, id ASC`,
    params,
  );
  return result.rows.map(mapRow);
}

async function updateBankAccountActive(
  executor: Executor = getPool(),
  accountId: string,
  isActive: boolean,
): Promise<HandymanBankAccountRow | null> {
  const result = await executor.query(
    `UPDATE handyman_bank_accounts
        SET is_active = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING id, client_id, building_id, bank_name, account_number,
                account_holder_name, display_name, currency, is_active,
                created_by_user_id, created_at, updated_at`,
    [accountId, isActive],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

export const handymanBankAccountRepository = {
  insertBankAccount,
  findBankAccountById,
  listBankAccountsByClient,
  updateBankAccountActive,
};

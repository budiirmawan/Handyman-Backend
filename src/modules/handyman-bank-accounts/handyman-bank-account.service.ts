import { getPool } from '../../database';
import { isValidUuid } from '../clients';
import { canAccessBuildingScopedResource } from '../context-access';
import { handymanCustomerTransactionNotAuthorizedError } from '../handyman-customer-transactions';
import { handymanExecutionScopeRepository } from '../handyman-quotations';
import {
  handymanBankAccountConflictError,
  handymanBankAccountInvalidError,
  handymanBankAccountNotFoundError,
} from './handyman-bank-account.errors';
import { handymanBankAccountRepository } from './handyman-bank-account.repository';
import type { HandymanBankAccountRecord } from './handyman-bank-account.types';
import { maskAccountNumber } from './handyman-bank-account.types';

/**
 * CR-HM-FINANCE-BANK-RECEIPT-ATTESTATION-01 — Destination bank account management.
 *
 * A configured payment destination is an OWNED bank account of the client.
 * Finance (handyman.finance.manage) creates them; Finance reads them.
 * Building-scoped accounts (buildingId != null) are only usable for scopes
 * in that exact building; client-wide accounts (buildingId = null) are usable
 * for any building of that client, subject to the caller's exact-Building
 * access on the execution scope (BE-02G).
 */

const PG_UNIQUE_VIOLATION = '23505';
const FREE_TEXT_MAX = 200;
const BANK_NAME_MAX = 100;
const ACCOUNT_NUMBER_MAX = 64;
const CURRENCIES = new Set(['IDR', 'USD', 'SGD', 'MYR', 'AUD', 'EUR', 'GBP', 'JPY', 'CNY']);

function ensureUuid(value: string, field: string): string {
  if (typeof value !== 'string' || !isValidUuid(value)) {
    throw handymanBankAccountInvalidError(field);
  }
  return value;
}

function ensureNonEmpty(value: unknown, field: string, maxLen: number): string {
  if (typeof value !== 'string') throw handymanBankAccountInvalidError(field);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLen) {
    throw handymanBankAccountInvalidError(field);
  }
  return trimmed;
}

function ensureCurrency(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!CURRENCIES.has(raw)) throw handymanBankAccountInvalidError('currency');
  return raw;
}

function toRecord(row: import('./handyman-bank-account.types').HandymanBankAccountRow): HandymanBankAccountRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    bankName: row.bankName,
    accountNumber: row.accountNumber, // keep full internally, but mask on exposure
    maskedAccountNumber: maskAccountNumber(row.accountNumber),
    accountHolderName: row.accountHolderName,
    displayName: row.displayName,
    currency: row.currency,
    isActive: row.isActive,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMaskedPayload(row: import('./handyman-bank-account.types').HandymanBankAccountRow) {
  return {
    id: row.id,
    clientId: row.clientId,
    buildingId: row.buildingId,
    bankName: row.bankName,
    maskedAccountNumber: maskAccountNumber(row.accountNumber),
    accountHolderName: row.accountHolderName,
    displayName: row.displayName,
    currency: row.currency,
    isActive: row.isActive,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createHandymanBankAccount(
  input: {
    clientId: string;
    buildingId?: string | null;
    bankName: string;
    accountNumber: string;
    accountHolderName: string;
    displayName: string;
    currency: string;
  },
  actorUserId: string,
): Promise<HandymanBankAccountRecord> {
  const clientId = ensureUuid(input.clientId, 'clientId');
  const buildingId = input.buildingId ? ensureUuid(input.buildingId, 'buildingId') : null;
  const bankName = ensureNonEmpty(input.bankName, 'bankName', BANK_NAME_MAX);
  const accountNumber = ensureNonEmpty(input.accountNumber, 'accountNumber', ACCOUNT_NUMBER_MAX);
  const accountHolderName = ensureNonEmpty(input.accountHolderName, 'accountHolderName', FREE_TEXT_MAX);
  const displayName = ensureNonEmpty(input.displayName, 'displayName', FREE_TEXT_MAX);
  const currency = ensureCurrency(input.currency);
  const actor = ensureUuid(actorUserId, 'actorUserId');

  // Validate building belongs to client (if scoped)
  if (buildingId) {
    const bRes = await getPool().query<{ client_id: string }>(
      `SELECT p.client_id FROM buildings b JOIN properties p ON p.id = b.property_id WHERE b.id = $1`,
      [buildingId],
    );
    if (!bRes.rows[0]) throw handymanBankAccountNotFoundError();
    if (String(bRes.rows[0].client_id) !== clientId) {
      throw handymanBankAccountInvalidError('buildingId');
    }
    // Caller must have access to that building
    if (!(await canAccessBuildingScopedResource(actor, { clientId, buildingId }))) {
      throw handymanCustomerTransactionNotAuthorizedError();
    }
  } else {
    // Client-level account: verify actor has at least one building assignment for this client
    // We don't enforce strict building scoping here; Finance permission + client access is enough
    // But we can check canAccessClient
    const { contextAccessService } = await import('../context-access');
    if (!(await contextAccessService.canAccessClient(actor, clientId))) {
      throw handymanCustomerTransactionNotAuthorizedError();
    }
  }

  try {
    const row = await handymanBankAccountRepository.insertBankAccount(undefined, {
      clientId,
      buildingId,
      bankName,
      accountNumber,
      accountHolderName,
      displayName,
      currency,
      createdByUserId: actor,
    });
    return toMaskedPayload(row) as unknown as HandymanBankAccountRecord;
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw handymanBankAccountConflictError('bank-account-already-exists');
    }
    throw e;
  }
}

export async function listHandymanBankAccounts(
  clientId: string,
  actorUserId: string,
  opts: { buildingId?: string | null; includeInactive?: boolean } = {},
): Promise<HandymanBankAccountRecord[]> {
  const cId = ensureUuid(clientId, 'clientId');
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const buildingId = opts.buildingId ? ensureUuid(opts.buildingId, 'buildingId') : null;

  const { contextAccessService } = await import('../context-access');
  // Prefer building-scoped check if buildingId provided
  if (buildingId) {
    if (!(await canAccessBuildingScopedResource(actor, { clientId: cId, buildingId }))) {
      throw handymanCustomerTransactionNotAuthorizedError();
    }
  } else {
    if (!(await contextAccessService.canAccessClient(actor, cId))) {
      throw handymanCustomerTransactionNotAuthorizedError();
    }
  }

  const rows = await handymanBankAccountRepository.listBankAccountsByClient(undefined, cId, {
    buildingId,
    includeInactive: opts.includeInactive,
  });
  return rows.map((r) => toMaskedPayload(r) as unknown as HandymanBankAccountRecord);
}

export async function getHandymanBankAccount(
  accountId: string,
  actorUserId: string,
): Promise<HandymanBankAccountRecord> {
  const aId = ensureUuid(accountId, 'accountId');
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const row = await handymanBankAccountRepository.findBankAccountById(undefined, aId);
  if (!row) throw handymanBankAccountNotFoundError();

  // Building-scoped check if account is building-scoped, else client check
  if (row.buildingId) {
    if (!(await canAccessBuildingScopedResource(actor, { clientId: row.clientId, buildingId: row.buildingId }))) {
      throw handymanCustomerTransactionNotAuthorizedError();
    }
  } else {
    const { contextAccessService } = await import('../context-access');
    if (!(await contextAccessService.canAccessClient(actor, row.clientId))) {
      throw handymanCustomerTransactionNotAuthorizedError();
    }
  }

  return toMaskedPayload(row) as unknown as HandymanBankAccountRecord;
}

export async function deactivateHandymanBankAccount(
  accountId: string,
  actorUserId: string,
): Promise<HandymanBankAccountRecord> {
  const aId = ensureUuid(accountId, 'accountId');
  const actor = ensureUuid(actorUserId, 'actorUserId');
  const row = await handymanBankAccountRepository.findBankAccountById(undefined, aId);
  if (!row) throw handymanBankAccountNotFoundError();

  if (row.buildingId) {
    if (!(await canAccessBuildingScopedResource(actor, { clientId: row.clientId, buildingId: row.buildingId }))) {
      throw handymanCustomerTransactionNotAuthorizedError();
    }
  } else {
    const { contextAccessService } = await import('../context-access');
    if (!(await contextAccessService.canAccessClient(actor, row.clientId))) {
      throw handymanCustomerTransactionNotAuthorizedError();
    }
  }

  const updated = await handymanBankAccountRepository.updateBankAccountActive(undefined, aId, false);
  if (!updated) throw handymanBankAccountNotFoundError();
  return toMaskedPayload(updated) as unknown as HandymanBankAccountRecord;
}

// Internal helper for attestation validation: fetch full row (with full account number for audit, but service never exposes it)
export async function getBankAccountForAttestation(
  executor: import('pg').PoolClient | undefined,
  accountId: string,
): Promise<import('./handyman-bank-account.types').HandymanBankAccountRow | null> {
  return handymanBankAccountRepository.findBankAccountById(executor as any, accountId);
}

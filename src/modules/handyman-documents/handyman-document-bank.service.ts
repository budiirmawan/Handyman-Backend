/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01B — issuer bank account authority.
 *
 * FOUR rules shape this service:
 *
 *  1. AUTHORITY. Managing where the provider asks to be paid is the same
 *     explicitly granted Handyman commercial act as the issuer profile
 *     (`handyman.commercial.manage`, no new permission/role/seed) plus the
 *     accessible-Client wall, so Care (`handyman.care.building`) and a Tenant
 *     PIC (`tenant_company.manage`) are refused and a same-permission manager
 *     of another provider is refused by scope. Customer money is never
 *     reachable from here.
 *  2. VERIFICATION IS AN ACT, NOT A DEFAULT. A stored account is
 *     PENDING_VERIFICATION until a named human confirms it against a named
 *     reference. Nothing here auto-verifies, and no path can set the
 *     verification columns from a content write: the only statement that can is
 *     `activate`, which re-checks the typed confirmation against the stored
 *     number. The platform records the operator's confirmation and never claims
 *     to have contacted a bank.
 *  3. MONEY DOES NOT MOVE SILENTLY. A content change appends a version and
 *     leaves the ACTIVE destination untouched until the new version is verified
 *     AND the replacement of the incumbent default is explicitly authorized;
 *     otherwise the call is refused with DEFAULT_TAKEN. Deactivating a default
 *     needs its own confirmation because it leaves that currency with no
 *     destination at all.
 *  4. HISTORY IS PRESERVED. Rows are never deleted or edited; the version chain
 *     is re-readable forever, account numbers are masked on every read, and the
 *     audit journal carries a mask plus a canonical digest - never the number.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { withTransaction } from '../../database/transaction';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { assertActiveAllowedCurrencyCommand } from '../client-monetary-contexts';
import { recordOperationalEvent } from '../operational-events';
import { AppError } from '../../shared/errors';
import { checksumBytes } from '../reporting-export/csv-renderer';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { handymanDocumentIssuerProfileRepository } from './handyman-document-issuer.repository';
import {
  handymanDocumentBankAccountConfirmationRequiredError,
  handymanDocumentBankAccountDefaultTakenError,
  handymanDocumentBankAccountNotFoundError,
  handymanDocumentBankAccountStateConflictError,
  handymanDocumentBankAccountVersionConflictError,
} from './handyman-document-bank.errors';
import {
  handymanDocumentBankAccountRepository as repository,
  type BankAccountRow,
} from './handyman-document-bank.repository';
import {
  HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS,
  HANDYMAN_DOCUMENT_BANK_ACCOUNT_ENTITY_TYPE,
  HANDYMAN_DOCUMENT_BANK_ACCOUNT_EVENT_TYPES,
  maskHandymanDocumentAccountNumber,
  type ActivateHandymanDocumentBankAccountInput,
  type CreateHandymanDocumentBankAccountInput,
  type DeactivateHandymanDocumentBankAccountInput,
  type HandymanDocumentBankAccountContent,
  type HandymanDocumentBankAccountContentField,
  type HandymanDocumentBankAccountSnapshot,
  type HandymanDocumentBankAccountUpdateResult,
  PublicHandymanDocumentBankAccount,
  type UpdateHandymanDocumentBankAccountInput,
} from './handyman-document-bank.types';
import type { HandymanDocumentBankAccountListFilter } from './handyman-document-bank.validation';

function ensureUuid(value: string, field: string): string {
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

function contentOf(
  record: BankAccountRow | HandymanDocumentBankAccountContent,
): HandymanDocumentBankAccountContent {
  const content = {} as HandymanDocumentBankAccountContent;
  for (const field of HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS) {
    (content as Record<string, unknown>)[field] =
      (record as Record<string, unknown>)[field] ?? null;
  }
  return content;
}

/** The masked read model: the stored number never leaves this module. */
export function toPublicHandymanDocumentBankAccount(
  row: BankAccountRow,
): PublicHandymanDocumentBankAccount {
  return {
    id: row.id,
    bankAccountId: row.bankAccountId,
    clientId: row.clientId,
    bankCode: row.bankCode,
    bankName: row.bankName,
    accountNumberMasked: maskHandymanDocumentAccountNumber(row.accountNumber),
    accountHolderName: row.accountHolderName,
    currency: row.currency,
    status: row.status,
    isDefault: row.isDefault,
    version: row.version,
    isLatestVersion: row.isLatestVersion,
    verificationReference: row.verificationReference,
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : null,
    verifiedByUserId: row.verifiedByUserId,
    deactivatedAt: row.deactivatedAt ? row.deactivatedAt.toISOString() : null,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    effectiveFrom: row.effectiveFrom.toISOString(),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function payloadChecksum(content: HandymanDocumentBankAccountContent): string {
  return checksumBytes(Buffer.from(stableJson(content), 'utf8'));
}

/** The same provider-Client authority seam the issuer profile uses - no second wall. */
async function assertBankAccountScope(actorUserId: string, clientId: string): Promise<void> {
  const client = await handymanDocumentIssuerProfileRepository.findClientAuthority(
    undefined,
    clientId,
  );
  if (!client || client.status !== 'ACTIVE') {
    throw AppError.notFound('Client not found.');
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string }).code === '23505';
}

function normalizeAccountNumber(value: string): string {
  return value.replace(/\s+/g, '');
}

async function assertActor(actorUserId: string): Promise<string> {
  return ensureUuid(actorUserId, 'actorUserId');
}

export async function listHandymanDocumentBankAccounts(
  clientIdInput: string,
  actorUserId: string,
  filter: HandymanDocumentBankAccountListFilter,
): Promise<PublicHandymanDocumentBankAccount[]> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  await assertActor(actorUserId);
  await assertBankAccountScope(actorUserId, clientId);
  const rows = await repository.listLiveAccounts(undefined, clientId, filter);
  return rows.map((row) => toPublicHandymanDocumentBankAccount(row));
}

export async function getHandymanDocumentBankAccount(
  clientIdInput: string,
  bankAccountIdInput: string,
  actorUserId: string,
): Promise<PublicHandymanDocumentBankAccount> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  const bankAccountId = ensureUuid(bankAccountIdInput, 'bankAccountId');
  await assertActor(actorUserId);
  await assertBankAccountScope(actorUserId, clientId);
  const row = await repository.findLatestByBankAccount(undefined, clientId, bankAccountId);
  if (!row) throw handymanDocumentBankAccountNotFoundError();
  return toPublicHandymanDocumentBankAccount(row);
}

export async function listHandymanDocumentBankAccountHistory(
  clientIdInput: string,
  bankAccountIdInput: string,
  actorUserId: string,
  limit = 20,
): Promise<PublicHandymanDocumentBankAccount[]> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  const bankAccountId = ensureUuid(bankAccountIdInput, 'bankAccountId');
  await assertActor(actorUserId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw AppError.validation('Request validation failed.', [
      { field: 'limit', message: 'limit must be an integer between 1 and 100.' },
    ]);
  }
  await assertBankAccountScope(actorUserId, clientId);
  const rows = await repository.listHistory(undefined, clientId, bankAccountId, limit);
  if (rows.length === 0) throw handymanDocumentBankAccountNotFoundError();
  return rows.map((row) => toPublicHandymanDocumentBankAccount(row));
}

async function journal(
  tx: Pick<PoolClient, 'query'>,
  input: {
    clientId: string;
    actorUserId: string;
    eventType: string;
    row: BankAccountRow;
    summary: string;
    extra?: Record<string, unknown>;
  },
): Promise<void> {
  const content = contentOf(input.row);
  await recordOperationalEvent(
    {
      clientId: input.clientId,
      buildingId: null,
      eventType: input.eventType,
      entityType: HANDYMAN_DOCUMENT_BANK_ACCOUNT_ENTITY_TYPE,
      entityId: input.row.bankAccountId,
      actorUserId: input.actorUserId,
      summary: input.summary,
      metadata: {
        versionRowId: input.row.id,
        bankAccountId: input.row.bankAccountId,
        version: input.row.version,
        status: input.row.status,
        isDefault: input.row.isDefault,
        currency: input.row.currency,
        bankCode: input.row.bankCode,
        // masked on purpose: the account number never enters the journal
        accountNumberMasked: maskHandymanDocumentAccountNumber(input.row.accountNumber),
        payloadChecksum: payloadChecksum(content),
        ...(input.extra ?? {}),
      },
    },
    tx,
  );
}

export async function createHandymanDocumentBankAccount(
  input: CreateHandymanDocumentBankAccountInput,
  actorUserId: string,
): Promise<PublicHandymanDocumentBankAccount> {
  const clientId = ensureUuid(input.clientId, 'clientId');
  const actor = await assertActor(actorUserId);
  await assertBankAccountScope(actor, clientId);
  // The platform's own currency authority: an active reference code that this
  // provider is allowed to transact in. No parallel currency list is invented.
  await assertActiveAllowedCurrencyCommand(clientId, input.currency);
  const content = contentOf(input);
  try {
    return await withTransaction(async (tx) => {
      await handymanDocumentIssuerProfileRepository.lockClientAuthority(tx, clientId);
      const created = await repository.insertAccount(tx, {
        clientId,
        createdByUserId: actor,
        content,
      });
      await journal(tx, {
        clientId,
        actorUserId: actor,
        eventType: HANDYMAN_DOCUMENT_BANK_ACCOUNT_EVENT_TYPES.created,
        row: created,
        summary: `Handyman document bank account ${created.currency} added and awaiting verification.`,
        extra: { requiresVerification: true },
      });
      return toPublicHandymanDocumentBankAccount(created);
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw handymanDocumentBankAccountStateConflictError(
        'An account chain for this identifier already exists; re-read the account and retry.',
      );
    }
    throw error;
  }
}

/**
 * Appends a new version of one account. The ACTIVE destination is deliberately
 * left exactly as it is: the new version only becomes a payment destination
 * through the verification + activation contract below.
 */
export async function updateHandymanDocumentBankAccount(
  input: UpdateHandymanDocumentBankAccountInput,
  actorUserId: string,
): Promise<HandymanDocumentBankAccountUpdateResult> {
  const clientId = ensureUuid(input.clientId, 'clientId');
  const bankAccountId = ensureUuid(input.bankAccountId, 'bankAccountId');
  const actor = await assertActor(actorUserId);
  await assertBankAccountScope(actor, clientId);
  await assertActiveAllowedCurrencyCommand(clientId, input.currency);
  const content = contentOf(input);

  return withTransaction(async (tx) => {
    await handymanDocumentIssuerProfileRepository.lockClientAuthority(tx, clientId);
    const latest = await repository.lockLatestByBankAccount(tx, clientId, bankAccountId);
    if (!latest) throw handymanDocumentBankAccountNotFoundError();
    if (latest.version !== input.expectedVersion) {
      throw handymanDocumentBankAccountVersionConflictError(latest.version);
    }
    if (latest.status === 'SUPERSEDED') {
      throw handymanDocumentBankAccountStateConflictError(
        'A retired account version cannot be amended; add the account again if it is in use.',
      );
    }
    const before = contentOf(latest);
    const changedFields = HANDYMAN_DOCUMENT_BANK_ACCOUNT_CONTENT_FIELDS.filter(
      (field) => before[field] !== content[field],
    );
    if (changedFields.length === 0) {
      throw handymanDocumentBankAccountStateConflictError(
        'The supplied account is identical to the stored one; there is nothing to change.',
      );
    }
    // A draft that was never a destination can be replaced outright; anything
    // that is live keeps its state until the replacement is verified AND
    // authorized, so a document's payment block never changes underneath it.
    if (latest.status === 'PENDING_VERIFICATION') {
      await repository.retire(tx, latest.id);
    }
    const created = await repository.insertAccount(tx, {
      clientId,
      createdByUserId: actor,
      content,
      bankAccountId: latest.bankAccountId,
      version: latest.version + 1,
    });
    await journal(tx, {
      clientId,
      actorUserId: actor,
      eventType: HANDYMAN_DOCUMENT_BANK_ACCOUNT_EVENT_TYPES.updated,
      row: created,
      summary: `Handyman document bank account amended to version ${created.version}; re-verification required.`,
      extra: {
        previousVersion: latest.version,
        // field NAMES only - a changed account number is never quoted back
        changedFields,
        previousVersionRetired: latest.status === 'PENDING_VERIFICATION',
        requiresVerification: true,
      },
    });
    return {
      ...toPublicHandymanDocumentBankAccount(created),
      previousVersion: latest.version,
      changedFields: changedFields as HandymanDocumentBankAccountContentField[],
      requiresVerification: true,
    };
  });
}

/**
 * The controlled verification act. Requires the typed confirmation to match the
 * stored number and a named reference, and only ever makes a row ACTIVE with
 * `verified_at` + `verified_by_user_id` recorded - which is what the 0491 CHECK
 * demands of any ACTIVE row.
 */
export async function activateHandymanDocumentBankAccount(
  input: ActivateHandymanDocumentBankAccountInput,
  actorUserId: string,
): Promise<PublicHandymanDocumentBankAccount> {
  const clientId = ensureUuid(input.clientId, 'clientId');
  const bankAccountId = ensureUuid(input.bankAccountId, 'bankAccountId');
  const actor = await assertActor(actorUserId);
  await assertBankAccountScope(actor, clientId);

  return withTransaction(async (tx) => {
    await handymanDocumentIssuerProfileRepository.lockClientAuthority(tx, clientId);
    const latest = await repository.lockLatestByBankAccount(tx, clientId, bankAccountId);
    if (!latest) throw handymanDocumentBankAccountNotFoundError();
    if (latest.version !== input.expectedVersion) {
      throw handymanDocumentBankAccountVersionConflictError(latest.version);
    }
    if (latest.status === 'ACTIVE') {
      throw handymanDocumentBankAccountStateConflictError(
        'This account version is already an active receiving account.',
      );
    }
    if (latest.status === 'SUPERSEDED') {
      throw handymanDocumentBankAccountStateConflictError(
        'A retired version cannot become a payment destination; activate the current version.',
      );
    }
    if (normalizeAccountNumber(input.confirmAccountNumber) !== latest.accountNumber) {
      // no echo of either value: the caller learns what to fix, not the number
      throw handymanDocumentBankAccountConfirmationRequiredError(
        'The typed confirmation does not match the account number on record.',
      );
    }
    let replacedVersionRowId: string | null = null;
    let replacedBankAccountId: string | null = null;
    let isDefault = false;
    if (input.asDefault) {
      const incumbent = await repository.findActiveDefault(tx, clientId, latest.currency);
      if (incumbent && incumbent.id !== latest.id) {
        // A DIFFERENT account taking over a currency is the decision that needs
        // its own authorization; a newer version of the SAME account is what the
        // amendment was for, and either way the incumbent row is retired - never
        // edited - so the history a document cited stays readable verbatim.
        if (incumbent.bankAccountId !== latest.bankAccountId && !input.authorizeReplacement) {
          throw handymanDocumentBankAccountDefaultTakenError([
            `${latest.currency} already has a default receiving account `
              + `(${incumbent.bankCode} ${maskHandymanDocumentAccountNumber(incumbent.accountNumber)}, `
              + `bankAccountId ${incumbent.bankAccountId}).`,
            'Send authorizeReplacement true to move the default; the incumbent is then preserved as history.',
          ]);
        }
        await repository.retire(tx, incumbent.id);
        replacedVersionRowId = incumbent.id;
        replacedBankAccountId = incumbent.bankAccountId;
      }
      isDefault = true;
    }
    const row =
      latest.status === 'PENDING_VERIFICATION'
        ? await repository.activatePending(tx, {
            id: latest.id,
            verifiedByUserId: actor,
            verificationReference: input.verificationReference,
            isDefault,
          })
        : await repository.reactivate(tx, { id: latest.id, isDefault });
    await journal(tx, {
      clientId,
      actorUserId: actor,
      eventType: HANDYMAN_DOCUMENT_BANK_ACCOUNT_EVENT_TYPES.activated,
      row,
      summary: isDefault
        ? `Handyman document bank account version ${row.version} verified as the ${row.currency} default receiving account.`
        : `Handyman document bank account version ${row.version} verified as an active receiving account.`,
      extra: {
        replacedVersionRowId,
        replacedBankAccountId,
        verificationReference: row.verificationReference,
        verifiedByUserId: actor,
        confirmation: 'MATCHED',
      },
    });
    return toPublicHandymanDocumentBankAccount(row);
  });
}

export async function deactivateHandymanDocumentBankAccount(
  input: DeactivateHandymanDocumentBankAccountInput,
  actorUserId: string,
): Promise<PublicHandymanDocumentBankAccount> {
  const clientId = ensureUuid(input.clientId, 'clientId');
  const bankAccountId = ensureUuid(input.bankAccountId, 'bankAccountId');
  const actor = await assertActor(actorUserId);
  await assertBankAccountScope(actor, clientId);

  return withTransaction(async (tx) => {
    await handymanDocumentIssuerProfileRepository.lockClientAuthority(tx, clientId);
    const latest = await repository.lockLatestByBankAccount(tx, clientId, bankAccountId);
    if (!latest) throw handymanDocumentBankAccountNotFoundError();
    if (latest.version !== input.expectedVersion) {
      throw handymanDocumentBankAccountVersionConflictError(latest.version);
    }
    if (latest.status !== 'ACTIVE') {
      throw handymanDocumentBankAccountStateConflictError(
        'Only an active receiving account can be deactivated.',
      );
    }
    if (latest.isDefault && !input.confirmLossOfDefault) {
      throw handymanDocumentBankAccountConfirmationRequiredError(
        `This is the default ${latest.currency} receiving account; deactivating it leaves that `
          + 'currency with no payment destination. Send confirmLossOfDefault true to proceed.',
      );
    }
    const row = await repository.suspend(tx, latest.id);
    await journal(tx, {
      clientId,
      actorUserId: actor,
      eventType: HANDYMAN_DOCUMENT_BANK_ACCOUNT_EVENT_TYPES.deactivated,
      row,
      summary: `Handyman document bank account version ${row.version} deactivated as a receiving account.`,
      extra: { reason: input.reason, wasDefault: latest.isDefault },
    });
    return toPublicHandymanDocumentBankAccount(row);
  });
}

/**
 * The read-only snapshot future document renderers pin: the one default ACTIVE
 * verified receiving account of this provider for the document's currency.
 *
 * FAILS CLOSED. A provider with no verified default for that currency gets
 * `HANDYMAN_DOCUMENT_BANK_ACCOUNT_NOT_FOUND` - it is never answered with a
 * placeholder, another currency's account, or an unverified draft, because a
 * document that invents payment instructions is a fraud vector, not a
 * convenience. (This is not an authorization seam: the caller has already
 * established whose document this is.)
 */
export async function resolveHandymanDocumentBankAccountSnapshot(
  clientIdInput: string,
  currencyInput: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanDocumentBankAccountSnapshot> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  const currency = String(currencyInput ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw AppError.validation('Request validation failed.', [
      { field: 'currency', message: 'currency must be an ISO-4217 3-letter code.' },
    ]);
  }
  const row = await repository.findActiveDefault(executor, clientId, currency);
  if (!row) throw handymanDocumentBankAccountNotFoundError();
  const content = contentOf(row);
  return freezeSnapshot({
    ...content,
    bankAccountId: row.bankAccountId,
    versionRowId: row.id,
    clientId: row.clientId,
    version: row.version,
    accountNumberMasked: maskHandymanDocumentAccountNumber(row.accountNumber),
    verifiedAt: row.verifiedAt ? row.verifiedAt.toISOString() : '',
    verifiedByUserId: row.verifiedByUserId ?? '',
    verificationReference: row.verificationReference,
    payloadChecksum: payloadChecksum(content),
    checksumAlgorithm: 'SHA-256',
  });
}

function freezeSnapshot(
  snapshot: HandymanDocumentBankAccountSnapshot,
): HandymanDocumentBankAccountSnapshot {
  for (const value of Object.values(snapshot as Record<string, unknown>)) {
    if (value && typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(snapshot);
}

export const handymanDocumentBankAccountService = {
  createHandymanDocumentBankAccount,
  getHandymanDocumentBankAccount,
  listHandymanDocumentBankAccounts,
  listHandymanDocumentBankAccountHistory,
  updateHandymanDocumentBankAccount,
  activateHandymanDocumentBankAccount,
  deactivateHandymanDocumentBankAccount,
  resolveHandymanDocumentBankAccountSnapshot,
};

/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01C — document settings authority.
 *
 *  1. AUTHORITY. Configuring how official documents read and who is named as
 *     signatory is the same explicitly granted Handyman commercial act as the
 *     issuer profile and the bank accounts (`handyman.commercial.manage`, no new
 *     permission/role/seed) plus the accessible-Client wall, so Customer Care and
 *     a Tenant PIC cannot reach it and a same-permission manager of another
 *     provider is refused by scope.
 *  2. VOICE, NOT CONTENT. This service can only ever write wording, a numbering
 *     prefix and a signatory name/title. It has no path to a price, a total, a
 *     tax, a down payment, an issued number, an acceptance, a consent flag, a
 *     warranty start date or a signature: those live in the quotation, BAST,
 *     invoice, warranty and bank-account authorities, and a configuration could
 *     not speak over them even if a caller asked (the ask itself is refused by the
 *     field vocabulary).
 *  3. APPEND-ONLY HISTORY. A change never overwrites: it inserts version+1 and
 *     retires the previous ACTIVE row inside one transaction, serialized per
 *     provider, so the wording a document was issued under is re-readable
 *     exactly as it was. `expectedVersion` is mandatory.
 *  4. ONE NAMESPACE PER PREFIX. Within a provider a prefix belongs to exactly
 *     one document kind (shared across that kind's two languages), so issued
 *     numbers stay unambiguous. This is a numbering-namespace rule only: the
 *     number itself is never produced here.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import { withTransaction } from '../../database/transaction';
import {
  buildingAccessDeniedError,
  contextAccessService,
} from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { AppError } from '../../shared/errors';
import { checksumBytes } from '../reporting-export/csv-renderer';
import { stableJson } from '../../shared/stable-json';
import { isValidUuid } from '../clients';
import { handymanDocumentIssuerProfileRepository } from './handyman-document-issuer.repository';
import {
  handymanDocumentSettingsNotFoundError,
  handymanDocumentSettingsPrefixConflictError,
  handymanDocumentSettingsVersionConflictError,
} from './handyman-document-settings.errors';
import { handymanDocumentSettingsRepository as repository } from './handyman-document-settings.repository';
import {
  HANDYMAN_DOCUMENT_SETTINGS_ENTITY_TYPE,
  HANDYMAN_DOCUMENT_SETTINGS_EVENT_TYPES,
  HANDYMAN_DOCUMENT_SETTINGS_FIELDS,
  type HandymanDocumentSettingsContent,
  type HandymanDocumentSettingsField,
  type HandymanDocumentSettingsKind,
  type HandymanDocumentSettingsLanguage,
  type HandymanDocumentSettingsRecord,
  type HandymanDocumentSettingsSnapshot,
  type HandymanDocumentSettingsUpdateInput,
  type HandymanDocumentSettingsUpdateResult,
  type PublicHandymanDocumentSettings,
} from './handyman-document-settings.types';

export const HANDYMAN_DOCUMENT_SETTINGS_HISTORY_DEFAULT_LIMIT = 20;
export const HANDYMAN_DOCUMENT_SETTINGS_HISTORY_MAX_LIMIT = 100;

function ensureUuid(value: string, field: string): string {
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

function contentOf(
  record: HandymanDocumentSettingsRecord | HandymanDocumentSettingsContent,
): HandymanDocumentSettingsContent {
  const content = {} as HandymanDocumentSettingsContent;
  for (const field of HANDYMAN_DOCUMENT_SETTINGS_FIELDS) {
    const value = (record as Record<string, unknown>)[field];
    (content as Record<string, unknown>)[field] =
      field === 'termsLines' ? [...((value as string[] | undefined) ?? [])] : (value ?? null);
  }
  return content;
}

function payloadChecksum(content: HandymanDocumentSettingsContent): string {
  return checksumBytes(Buffer.from(stableJson(content), 'utf8'));
}

export function toPublicHandymanDocumentSettings(
  record: HandymanDocumentSettingsRecord,
): PublicHandymanDocumentSettings {
  return {
    ...contentOf(record),
    id: record.id,
    clientId: record.clientId,
    documentKind: record.documentKind,
    language: record.language,
    status: record.status,
    version: record.version,
    effectiveFrom: record.effectiveFrom.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
  };
}

/** The same provider-Client authority seam as 0490/0491 - no second wall. */
async function assertSettingsScope(
  actorUserId: string,
  clientId: string,
  executor?: Pick<PoolClient, 'query'>,
): Promise<void> {
  const client = await handymanDocumentIssuerProfileRepository.findClientAuthority(
    executor,
    clientId,
  );
  if (!client || client.status !== 'ACTIVE') {
    throw AppError.notFound('Client not found.');
  }
  if (!(await contextAccessService.canAccessClient(actorUserId, clientId))) {
    throw buildingAccessDeniedError();
  }
}

function sqlState(error: unknown): string {
  return String((error as { code?: string }).code ?? (error as { errno?: string }).errno ?? '');
}

export async function getHandymanDocumentSettings(
  clientIdInput: string,
  documentKind: HandymanDocumentSettingsKind,
  language: HandymanDocumentSettingsLanguage,
  actorUserId: string,
): Promise<PublicHandymanDocumentSettings> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  ensureUuid(actorUserId, 'actorUserId');
  await assertSettingsScope(actorUserId, clientId);
  const record = await repository.findActive(undefined, clientId, documentKind, language);
  if (!record) throw handymanDocumentSettingsNotFoundError();
  return toPublicHandymanDocumentSettings(record);
}

export async function listHandymanDocumentSettings(
  clientIdInput: string,
  actorUserId: string,
): Promise<PublicHandymanDocumentSettings[]> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  ensureUuid(actorUserId, 'actorUserId');
  await assertSettingsScope(actorUserId, clientId);
  const records = await repository.listActiveByClient(undefined, clientId);
  return records.map(toPublicHandymanDocumentSettings);
}

export async function listHandymanDocumentSettingsHistory(
  clientIdInput: string,
  documentKind: HandymanDocumentSettingsKind,
  language: HandymanDocumentSettingsLanguage,
  actorUserId: string,
  limit = HANDYMAN_DOCUMENT_SETTINGS_HISTORY_DEFAULT_LIMIT,
): Promise<PublicHandymanDocumentSettings[]> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  ensureUuid(actorUserId, 'actorUserId');
  if (
    !Number.isInteger(limit)
    || limit < 1
    || limit > HANDYMAN_DOCUMENT_SETTINGS_HISTORY_MAX_LIMIT
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'limit',
        message: `limit must be an integer between 1 and ${HANDYMAN_DOCUMENT_SETTINGS_HISTORY_MAX_LIMIT}.`,
      },
    ]);
  }
  await assertSettingsScope(actorUserId, clientId);
  const records = await repository.listHistory(undefined, clientId, documentKind, language, limit);
  if (records.length === 0) throw handymanDocumentSettingsNotFoundError();
  return records.map(toPublicHandymanDocumentSettings);
}

export async function updateHandymanDocumentSettings(
  input: HandymanDocumentSettingsUpdateInput,
  actorUserId: string,
): Promise<HandymanDocumentSettingsUpdateResult> {
  const clientId = ensureUuid(input.clientId, 'clientId');
  ensureUuid(actorUserId, 'actorUserId');
  await assertSettingsScope(actorUserId, clientId);
  const content = contentOf(input);
  if (input.documentKind === 'PAYMENT_RECEIPT' && content.documentPrefix !== 'HM-PR') {
    throw AppError.validation('PAYMENT_RECEIPT requires the HM-PR prefix.');
  }

  try {
    return await withTransaction(async (tx) => {
      // One provider-wide serialization point first: it makes the prefix
      // namespace rule below race-free, not just checked.
      await handymanDocumentIssuerProfileRepository.lockClientAuthority(tx, clientId);
      const current = await repository.lockActive(tx, clientId, input.documentKind, input.language);
      const currentVersion = current ? current.version : null;
      if (currentVersion !== input.expectedVersion) {
        throw handymanDocumentSettingsVersionConflictError(currentVersion);
      }
      const ownerKind = await repository.findPrefixOwnerKind(tx, clientId, content.documentPrefix);
      if (ownerKind && ownerKind !== input.documentKind) {
        throw handymanDocumentSettingsPrefixConflictError(ownerKind);
      }
      // Retire first, then insert: "exactly one ACTIVE row per
      // (client, kind, language)" is a DB invariant (partial unique index).
      if (current) await repository.markSuperseded(tx, current.id);
      const created = await repository.insertSettings(tx, {
        clientId,
        documentKind: input.documentKind,
        language: input.language,
        version: (currentVersion ?? 0) + 1,
        createdByUserId: actorUserId,
        content,
      });
      const changedFields = current ? diffFields(current, content) : [...HANDYMAN_DOCUMENT_SETTINGS_FIELDS];

      await recordOperationalEvent(
        {
          clientId,
          buildingId: null,
          eventType: current
            ? HANDYMAN_DOCUMENT_SETTINGS_EVENT_TYPES.updated
            : HANDYMAN_DOCUMENT_SETTINGS_EVENT_TYPES.created,
          entityType: HANDYMAN_DOCUMENT_SETTINGS_ENTITY_TYPE,
          entityId: created.id,
          actorUserId,
          summary: current
            ? `Handyman ${created.documentKind} (${created.language}) document settings updated to version ${created.version}.`
            : `Handyman ${created.documentKind} (${created.language}) document settings created.`,
          metadata: {
            settingsId: created.id,
            documentKind: created.documentKind,
            language: created.language,
            version: created.version,
            previousVersion: currentVersion,
            status: created.status,
            documentPrefix: created.documentPrefix,
            termsLineCount: created.termsLines.length,
            changedFields,
            payloadChecksum: payloadChecksum(content),
          },
        },
        tx,
      );

      return {
        ...toPublicHandymanDocumentSettings(created),
        previousVersion: currentVersion,
        changedFields,
      };
    });
  } catch (error) {
    if (sqlState(error) === '23P01') {
      throw handymanDocumentSettingsPrefixConflictError(input.documentKind);
    }
    if (sqlState(error) === '23505') {
      const current = await repository.findActive(
        undefined,
        clientId,
        input.documentKind,
        input.language,
      );
      throw handymanDocumentSettingsVersionConflictError(current ? current.version : null);
    }
    throw error;
  }
}

function diffFields(
  current: HandymanDocumentSettingsRecord,
  next: HandymanDocumentSettingsContent,
): HandymanDocumentSettingsField[] {
  const before = contentOf(current);
  return HANDYMAN_DOCUMENT_SETTINGS_FIELDS.filter((field) => {
    const left = before[field];
    const right = next[field];
    if (Array.isArray(left) || Array.isArray(right)) {
      return JSON.stringify(left) !== JSON.stringify(right);
    }
    return left !== right;
  });
}

/**
 * The read-only snapshot a future PDF issuance pins: the effective settings of
 * one provider for one document kind and language, deep-frozen, versioned and
 * digested.
 *
 * FAILS CLOSED. There is no fallback wording invented here and no silent
 * language substitution: an unconfigured provider gets
 * `HANDYMAN_DOCUMENT_SETTINGS_NOT_FOUND`, because a document that guesses terms,
 * a signatory or a numbering namespace is exactly the fabrication this CR
 * forbids. (Not an authorization seam: the caller has already established whose
 * document this is.)
 */
export async function resolveHandymanDocumentSettingsSnapshot(
  clientIdInput: string,
  documentKind: HandymanDocumentSettingsKind,
  language: HandymanDocumentSettingsLanguage,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanDocumentSettingsSnapshot> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  const record = await repository.findActive(executor, clientId, documentKind, language);
  if (!record) throw handymanDocumentSettingsNotFoundError();
  const content = contentOf(record);
  return freezeSnapshot({
    ...content,
    settingsId: record.id,
    clientId: record.clientId,
    documentKind: record.documentKind,
    language: record.language,
    version: record.version,
    payloadChecksum: payloadChecksum(content),
    checksumAlgorithm: 'SHA-256',
  });
}

function freezeSnapshot(
  snapshot: HandymanDocumentSettingsSnapshot,
): HandymanDocumentSettingsSnapshot {
  for (const value of Object.values(snapshot as Record<string, unknown>)) {
    if (value && typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(snapshot);
}

export const handymanDocumentSettingsService = {
  getHandymanDocumentSettings,
  listHandymanDocumentSettings,
  listHandymanDocumentSettingsHistory,
  updateHandymanDocumentSettings,
  resolveHandymanDocumentSettingsSnapshot,
};

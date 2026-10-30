/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01A — issuer profile authority.
 *
 * THREE rules shape this service:
 *
 *  1. AUTHORITY. Editing the issuer identity is an explicitly permitted
 *     Handyman Operations Manager act: the route layer requires
 *     `handyman.commercial.manage` (the existing Handyman commercial-authority
 *     code, deliberately no new permission/role/seed) AND the service re-checks
 *     the provider-Client scope with the accessible-Client wall. Customer Care
 *     (`handyman.care.building`) and a Tenant PIC (`tenant_company.manage`)
 *     therefore cannot reach this master data even though both carry
 *     permissions that look adjacent - neither holds the commercial code, and
 *     scope is never treated as a substitute for it (or the reverse).
 *  2. APPEND-ONLY HISTORY. A change never overwrites: it inserts version+1 and
 *     retires the previous ACTIVE row (SUPERSEDED), inside one transaction,
 *     serialized per Client. `expectedVersion` is mandatory, so a stale writer
 *     is refused with a conflict instead of silently winning.
 *  3. NO LOOK-AHEAD MUTATION. Nothing here rewrites a document that was already
 *     issued. The snapshot resolver hands out an immutable, self-describing
 *     value (profile id + version + canonical SHA-256 payload digest) that the
 *     document lane pins at render time; a later profile change can only produce
 *     a NEW snapshot for FUTURE documents.
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
import {
  handymanDocumentIssuerProfileNotFoundError,
  handymanDocumentIssuerProfileVersionConflictError,
} from './handyman-document-issuer.errors';
import { handymanDocumentIssuerProfileRepository as repository } from './handyman-document-issuer.repository';
import {
  HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS,
  HANDYMAN_DOCUMENT_ISSUER_SNAPSHOT_ENTITY_TYPE,
  HANDYMAN_DOCUMENT_ISSUER_SNAPSHOT_EVENT_TYPES,
  type HandymanDocumentIssuerProfileContent,
  type HandymanDocumentIssuerProfileField,
  type HandymanDocumentIssuerProfileRecord,
  type HandymanDocumentIssuerProfileUpdateResult,
  type HandymanDocumentIssuerSnapshot,
  type PublicHandymanDocumentIssuerProfile,
  type UpdateHandymanDocumentIssuerProfileInput,
} from './handyman-document-issuer.types';

/** The default history page size (a listing bound, never a business rule). */
export const HANDYMAN_DOCUMENT_ISSUER_HISTORY_DEFAULT_LIMIT = 20;
export const HANDYMAN_DOCUMENT_ISSUER_HISTORY_MAX_LIMIT = 100;

function ensureUuid(value: string, field: string): string {
  if (!isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
  return value.toLowerCase();
}

function contentOf(
  record: HandymanDocumentIssuerProfileRecord | HandymanDocumentIssuerProfileContent,
): HandymanDocumentIssuerProfileContent {
  const content = {} as HandymanDocumentIssuerProfileContent;
  for (const field of HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS) {
    (content as Record<string, unknown>)[field] = (record as Record<string, unknown>)[field] ?? null;
  }
  return content;
}

export function toPublicHandymanDocumentIssuerProfile(
  record: HandymanDocumentIssuerProfileRecord,
): PublicHandymanDocumentIssuerProfile {
  return {
    ...contentOf(record),
    id: record.id,
    clientId: record.clientId,
    status: record.status,
    version: record.version,
    effectiveFrom: record.effectiveFrom.toISOString(),
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    supersededAt: record.supersededAt ? record.supersededAt.toISOString() : null,
  };
}

/**
 * Provider-Client existence + accessible-Client wall. Ordering is fixed:
 * 404 for an unknown/inactive Client, 403 for an out-of-scope actor, and only
 * then any write - so no unauthorized actor learns anything and nothing is
 * touched before authorization.
 */
async function assertIssuerProfileScope(actorUserId: string, clientId: string): Promise<void> {
  const client = await repository.findClientAuthority(undefined, clientId);
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

/**
 * Reads the ACTIVE issuer profile of one provider Client. Refuses with
 * `HANDYMAN_DOCUMENT_ISSUER_PROFILE_NOT_FOUND` while none exists: an official
 * document has no issuer identity to print yet, and inventing one is worse
 * than failing.
 */
export async function getHandymanDocumentIssuerProfile(
  clientIdInput: string,
  actorUserId: string,
): Promise<PublicHandymanDocumentIssuerProfile> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  ensureUuid(actorUserId, 'actorUserId');
  await assertIssuerProfileScope(actorUserId, clientId);
  const record = await repository.findActiveByClient(undefined, clientId);
  if (!record) throw handymanDocumentIssuerProfileNotFoundError();
  return toPublicHandymanDocumentIssuerProfile(record);
}

/** Full version chain, newest first: what was issued when stays readable. */
export async function listHandymanDocumentIssuerProfileHistory(
  clientIdInput: string,
  actorUserId: string,
  limit = HANDYMAN_DOCUMENT_ISSUER_HISTORY_DEFAULT_LIMIT,
): Promise<PublicHandymanDocumentIssuerProfile[]> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  ensureUuid(actorUserId, 'actorUserId');
  if (!Number.isInteger(limit) || limit < 1 || limit > HANDYMAN_DOCUMENT_ISSUER_HISTORY_MAX_LIMIT) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'limit',
        message: `limit must be an integer between 1 and ${HANDYMAN_DOCUMENT_ISSUER_HISTORY_MAX_LIMIT}.`,
      },
    ]);
  }
  await assertIssuerProfileScope(actorUserId, clientId);
  const records = await repository.listHistoryByClient(undefined, clientId, limit);
  return records.map(toPublicHandymanDocumentIssuerProfile);
}

export async function updateHandymanDocumentIssuerProfile(
  input: UpdateHandymanDocumentIssuerProfileInput,
  actorUserId: string,
): Promise<HandymanDocumentIssuerProfileUpdateResult> {
  const clientId = ensureUuid(input.clientId, 'clientId');
  ensureUuid(actorUserId, 'actorUserId');
  await assertIssuerProfileScope(actorUserId, clientId);
  const content = contentOf(input);

  try {
    return await withTransaction(async (tx) => {
      await repository.lockClientAuthority(tx, clientId);
      const current = await repository.lockActiveByClient(tx, clientId);
      const currentVersion = current ? current.version : null;
      if (currentVersion !== input.expectedVersion) {
        throw handymanDocumentIssuerProfileVersionConflictError(currentVersion);
      }
      const version = (currentVersion ?? 0) + 1;
      // Retire first, then insert: "exactly one ACTIVE row per Client" is a DB
      // invariant (partial unique index), so the swap has to happen in this
      // order inside the same transaction.
      if (current) await repository.markSuperseded(tx, current.id);
      const created = await repository.insertProfile(tx, {
        clientId,
        version,
        createdByUserId: actorUserId,
        content,
      });
      const changedFields = diffFields(current, content);

      // Audit-only journal: the profile table remains the authority, and the
      // event carries the field names (never secrets or binaries).
      await recordOperationalEvent(
        {
          clientId,
          buildingId: null,
          eventType: current
            ? HANDYMAN_DOCUMENT_ISSUER_SNAPSHOT_EVENT_TYPES.updated
            : HANDYMAN_DOCUMENT_ISSUER_SNAPSHOT_EVENT_TYPES.created,
          entityType: HANDYMAN_DOCUMENT_ISSUER_SNAPSHOT_ENTITY_TYPE,
          entityId: created.id,
          actorUserId,
          summary: current
            ? `Handyman document issuer profile updated to version ${version}.`
            : `Handyman document issuer profile created for the service provider.`,
          metadata: {
            profileId: created.id,
            version,
            previousVersionId: current ? current.id : null,
            previousVersion: currentVersion,
            status: created.status,
            changedFields,
            payloadChecksum: payloadChecksum(content),
          },
        },
        tx,
      );

      return {
        ...toPublicHandymanDocumentIssuerProfile(created),
        previousVersion: currentVersion,
        changedFields,
      };
    });
  } catch (error) {
    // One ACTIVE row and one row per (client, version) are DB invariants: a
    // race that slips past the lock is a conflict, never a double write.
    if (isUniqueViolation(error)) {
      const current = await repository.findActiveByClient(undefined, clientId);
      throw handymanDocumentIssuerProfileVersionConflictError(
        current ? current.version : null,
      );
    }
    throw error;
  }
}

function diffFields(
  current: HandymanDocumentIssuerProfileRecord | null,
  next: HandymanDocumentIssuerProfileContent,
): HandymanDocumentIssuerProfileField[] {
  if (!current) return [...HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS];
  const before = contentOf(current);
  return HANDYMAN_DOCUMENT_ISSUER_PROFILE_FIELDS.filter(
    (field) => before[field] !== next[field],
  );
}

function payloadChecksum(content: HandymanDocumentIssuerProfileContent): string {
  return checksumBytes(Buffer.from(stableJson(content), 'utf8'));
}

/**
 * The read-only snapshot the future document renderers pin. No actor scope is
 * consulted here on purpose: this is not an authorization seam, it is the
 * identity a document was issued under, and it is resolved from the ACTIVE row
 * at call time and returned deep-frozen with its canonical digest.
 */
export async function resolveHandymanDocumentIssuerSnapshot(
  clientIdInput: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanDocumentIssuerSnapshot> {
  const clientId = ensureUuid(clientIdInput, 'clientId');
  const record = await repository.findActiveByClient(executor, clientId);
  if (!record) throw handymanDocumentIssuerProfileNotFoundError();
  const content = contentOf(record);
  return freezeSnapshot({
    ...content,
    profileId: record.id,
    clientId: record.clientId,
    version: record.version,
    payloadChecksum: payloadChecksum(content),
    checksumAlgorithm: 'SHA-256',
  });
}

function freezeSnapshot(snapshot: HandymanDocumentIssuerSnapshot): HandymanDocumentIssuerSnapshot {
  for (const value of Object.values(snapshot as Record<string, unknown>)) {
    if (value && typeof value === 'object') Object.freeze(value);
  }
  return Object.freeze(snapshot);
}

export const handymanDocumentIssuerProfileService = {
  getHandymanDocumentIssuerProfile,
  listHandymanDocumentIssuerProfileHistory,
  updateHandymanDocumentIssuerProfile,
  resolveHandymanDocumentIssuerSnapshot,
};

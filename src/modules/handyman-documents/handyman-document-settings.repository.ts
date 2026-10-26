/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01C — document settings persistence.
 *
 * Executor-first, exactly like the 0490/0491 repositories. There is no UPDATE
 * path for a content column anywhere in this file: a change inserts version+1 and
 * retires the previous ACTIVE row, which is the only write the 0492 trigger
 * permits - so the version chain is append-only by construction, not by
 * convention.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanDocumentSettingsContent,
  HandymanDocumentSettingsKind,
  HandymanDocumentSettingsLanguage,
  HandymanDocumentSettingsRecord,
  HandymanDocumentSettingsStatus,
} from './handyman-document-settings.types';

type SettingsRow = {
  id: string;
  client_id: string;
  document_kind: HandymanDocumentSettingsKind;
  language: HandymanDocumentSettingsLanguage;
  document_prefix: string;
  terms_lines: string[];
  payment_note: string | null;
  warranty_note: string | null;
  footer_note: string | null;
  contact_note: string | null;
  signatory_name: string;
  signatory_title: string;
  status: HandymanDocumentSettingsStatus;
  version: number;
  effective_from: Date;
  created_by_user_id: string;
  created_at: Date;
  superseded_at: Date | null;
};

const COLUMNS = `
  id, client_id, document_kind, language, document_prefix, terms_lines, payment_note,
  warranty_note, footer_note, contact_note, signatory_name, signatory_title, status,
  version, effective_from, created_by_user_id, created_at, superseded_at`;

function mapProfile(row: SettingsRow): HandymanDocumentSettingsRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    documentKind: row.document_kind,
    language: row.language,
    documentPrefix: row.document_prefix,
    termsLines: [...(row.terms_lines ?? [])],
    paymentNote: row.payment_note,
    warrantyNote: row.warranty_note,
    footerNote: row.footer_note,
    contactNote: row.contact_note,
    signatoryName: row.signatory_name,
    signatoryTitle: row.signatory_title,
    status: row.status,
    version: row.version,
    effectiveFrom: row.effective_from,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  };
}

export async function findActive(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  documentKind: HandymanDocumentSettingsKind,
  language: HandymanDocumentSettingsLanguage,
): Promise<HandymanDocumentSettingsRecord | null> {
  const result = await executor.query<SettingsRow>(
    `SELECT ${COLUMNS} FROM handyman_document_issuer_document_settings
      WHERE client_id = $1 AND document_kind = $2 AND language = $3 AND status = 'ACTIVE'
      LIMIT 1`,
    [clientId, documentKind, language],
  );
  const row = result.rows[0];
  return row ? mapProfile(row) : null;
}

/** The only permitted lifecycle write, so it must be read under the same lock. */
export async function lockActive(
  tx: Pick<PoolClient, 'query'>,
  clientId: string,
  documentKind: HandymanDocumentSettingsKind,
  language: HandymanDocumentSettingsLanguage,
): Promise<HandymanDocumentSettingsRecord | null> {
  const result = await tx.query<SettingsRow>(
    `SELECT ${COLUMNS} FROM handyman_document_issuer_document_settings
      WHERE client_id = $1 AND document_kind = $2 AND language = $3 AND status = 'ACTIVE'
      LIMIT 1
      FOR UPDATE`,
    [clientId, documentKind, language],
  );
  const row = result.rows[0];
  return row ? mapProfile(row) : null;
}

/** Which ACTIVE document type already owns this prefix (the namespace guard). */
export async function findPrefixOwnerKind(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  documentPrefix: string,
): Promise<HandymanDocumentSettingsKind | null> {
  const result = await executor.query<{ document_kind: HandymanDocumentSettingsKind }>(
    `SELECT document_kind FROM handyman_document_issuer_document_settings
      WHERE client_id = $1 AND document_prefix = $2 AND status = 'ACTIVE'
      ORDER BY document_kind
      LIMIT 1`,
    [clientId, documentPrefix],
  );
  return result.rows[0]?.document_kind ?? null;
}

export async function listActiveByClient(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
): Promise<HandymanDocumentSettingsRecord[]> {
  const result = await executor.query<SettingsRow>(
    `SELECT ${COLUMNS} FROM handyman_document_issuer_document_settings
      WHERE client_id = $1 AND status = 'ACTIVE'
      ORDER BY document_kind, language`,
    [clientId],
  );
  return result.rows.map(mapProfile);
}

export async function listHistory(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  documentKind: HandymanDocumentSettingsKind,
  language: HandymanDocumentSettingsLanguage,
  limit: number,
): Promise<HandymanDocumentSettingsRecord[]> {
  const result = await executor.query<SettingsRow>(
    `SELECT ${COLUMNS} FROM handyman_document_issuer_document_settings
      WHERE client_id = $1 AND document_kind = $2 AND language = $3
      ORDER BY version DESC, created_at DESC, id DESC
      LIMIT $4`,
    [clientId, documentKind, language, limit],
  );
  return result.rows.map(mapProfile);
}

export async function insertSettings(
  tx: Pick<PoolClient, 'query'>,
  input: {
    clientId: string;
    documentKind: HandymanDocumentSettingsKind;
    language: HandymanDocumentSettingsLanguage;
    version: number;
    createdByUserId: string;
    content: HandymanDocumentSettingsContent;
  },
): Promise<HandymanDocumentSettingsRecord> {
  const { content } = input;
  const result = await tx.query<SettingsRow>(
    `INSERT INTO handyman_document_issuer_document_settings
       (id, client_id, document_kind, language, document_prefix, terms_lines, payment_note,
        warranty_note, footer_note, contact_note, signatory_name, signatory_title, status,
        version, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE', $13, $14)
     RETURNING ${COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      input.documentKind,
      input.language,
      content.documentPrefix,
      content.termsLines,
      content.paymentNote,
      content.warrantyNote,
      content.footerNote,
      content.contactNote,
      content.signatoryName,
      content.signatoryTitle,
      input.version,
      input.createdByUserId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Document settings insert returned no row.');
  return mapProfile(row);
}

/** The only permitted UPDATE on the table: the ACTIVE -> SUPERSEDED projection. */
export async function markSuperseded(
  tx: Pick<PoolClient, 'query'>,
  id: string,
): Promise<void> {
  await tx.query(
    `UPDATE handyman_document_issuer_document_settings
        SET status = 'SUPERSEDED', superseded_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id],
  );
}

export const handymanDocumentSettingsRepository = {
  findActive,
  lockActive,
  findPrefixOwnerKind,
  listActiveByClient,
  listHistory,
  insertSettings,
  markSuperseded,
};

/**
 * CR-HM-DOCUMENT-PROFILE-01 PART 01A — issuer profile persistence.
 *
 * Executor-first convention (shared pool by default, transaction executor as
 * the FIRST argument), exactly like the other Handyman master-data
 * repositories. There is no UPDATE path for content columns anywhere in this
 * file: a change is `insert new version + retire the previous ACTIVE row`, so
 * the version chain stays append-only (migration 0490 enforces it in the DB).
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanDocumentIssuerProfileContent,
  HandymanDocumentIssuerProfileRecord,
} from './handyman-document-issuer.types';

type ProfileRow = {
  id: string;
  client_id: string;
  legal_name: string;
  display_name: string;
  registered_address: string;
  business_address: string | null;
  city: string;
  province: string;
  postal_code: string;
  email: string;
  phone: string;
  whatsapp: string;
  website: string | null;
  tax_id: string | null;
  business_registration_id: string | null;
  logo_reference: string | null;
  status: HandymanDocumentIssuerProfileRecord['status'];
  version: number;
  effective_from: Date;
  created_by_user_id: string;
  created_at: Date;
  superseded_at: Date | null;
};

const COLUMNS = `
  id, client_id, legal_name, display_name, registered_address, business_address,
  city, province, postal_code, email, phone, whatsapp, website, tax_id,
  business_registration_id, logo_reference, status, version, effective_from,
  created_by_user_id, created_at, superseded_at`;

function mapProfile(row: ProfileRow): HandymanDocumentIssuerProfileRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    legalName: row.legal_name,
    displayName: row.display_name,
    registeredAddress: row.registered_address,
    businessAddress: row.business_address,
    city: row.city,
    province: row.province,
    postalCode: row.postal_code,
    email: row.email,
    phone: row.phone,
    whatsapp: row.whatsapp,
    website: row.website,
    taxId: row.tax_id,
    businessRegistrationId: row.business_registration_id,
    logoReference: row.logo_reference,
    status: row.status,
    version: row.version,
    effectiveFrom: row.effective_from,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    supersededAt: row.superseded_at,
  };
}

/** The provider Client authority row (identity of the Handyman operator). */
export async function findClientAuthority(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
): Promise<{ id: string; status: string } | null> {
  const result = await executor.query<{ id: string; status: string }>(
    'SELECT id, status FROM clients WHERE id = $1',
    [clientId],
  );
  return result.rows[0] ?? null;
}

/**
 * Serializes issuer-profile writers for one Client BEFORE the ACTIVE row is
 * read, so two concurrent updates queue instead of racing the one-ACTIVE index
 * (the same technique the per-Building geofence policy uses).
 */
export async function lockClientAuthority(
  tx: Pick<PoolClient, 'query'>,
  clientId: string,
): Promise<void> {
  await tx.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [clientId]);
}

export async function findActiveByClient(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
): Promise<HandymanDocumentIssuerProfileRecord | null> {
  const result = await executor.query<ProfileRow>(
    `SELECT ${COLUMNS} FROM handyman_document_issuer_profiles
      WHERE client_id = $1 AND status = 'ACTIVE'
      LIMIT 1`,
    [clientId],
  );
  const row = result.rows[0];
  return row ? mapProfile(row) : null;
}

export async function lockActiveByClient(
  tx: Pick<PoolClient, 'query'>,
  clientId: string,
): Promise<HandymanDocumentIssuerProfileRecord | null> {
  const result = await tx.query<ProfileRow>(
    `SELECT ${COLUMNS} FROM handyman_document_issuer_profiles
      WHERE client_id = $1 AND status = 'ACTIVE'
      LIMIT 1
      FOR UPDATE`,
    [clientId],
  );
  const row = result.rows[0];
  return row ? mapProfile(row) : null;
}

export async function insertProfile(
  tx: Pick<PoolClient, 'query'>,
  input: {
    clientId: string;
    version: number;
    createdByUserId: string;
    content: HandymanDocumentIssuerProfileContent;
  },
): Promise<HandymanDocumentIssuerProfileRecord> {
  const { content } = input;
  const result = await tx.query<ProfileRow>(
    `INSERT INTO handyman_document_issuer_profiles
       (id, client_id, legal_name, display_name, registered_address, business_address,
        city, province, postal_code, email, phone, whatsapp, website, tax_id,
        business_registration_id, logo_reference, status, version, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             'ACTIVE', $17, $18)
     RETURNING ${COLUMNS}`,
    [
      randomUUID(),
      input.clientId,
      content.legalName,
      content.displayName,
      content.registeredAddress,
      content.businessAddress,
      content.city,
      content.province,
      content.postalCode,
      content.email,
      content.phone,
      content.whatsapp,
      content.website,
      content.taxId,
      content.businessRegistrationId,
      content.logoReference,
      input.version,
      input.createdByUserId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Issuer profile insert returned no row.');
  return mapProfile(row);
}

/** The only permitted UPDATE on the table: the ACTIVE -> SUPERSEDED projection. */
export async function markSuperseded(
  tx: Pick<PoolClient, 'query'>,
  id: string,
): Promise<void> {
  await tx.query(
    `UPDATE handyman_document_issuer_profiles
        SET status = 'SUPERSEDED', superseded_at = NOW()
      WHERE id = $1 AND status = 'ACTIVE'`,
    [id],
  );
}

export async function listHistoryByClient(
  executor: Pick<PoolClient, 'query'> = getPool(),
  clientId: string,
  limit = 20,
): Promise<HandymanDocumentIssuerProfileRecord[]> {
  const result = await executor.query<ProfileRow>(
    `SELECT ${COLUMNS} FROM handyman_document_issuer_profiles
      WHERE client_id = $1
      ORDER BY version DESC, created_at DESC, id DESC
      LIMIT $2`,
    [clientId, limit],
  );
  return result.rows.map(mapProfile);
}

export const handymanDocumentIssuerProfileRepository = {
  findClientAuthority,
  lockClientAuthority,
  findActiveByClient,
  lockActiveByClient,
  insertProfile,
  markSuperseded,
  listHistoryByClient,
};

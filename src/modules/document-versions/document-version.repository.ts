import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { DocumentVersionRecord } from './document-version.types';

const SELECT = `
  id,
  document_id AS "documentId",
  version_number AS "versionNumber",
  title,
  description,
  file_reference AS "fileReference",
  document_type AS "documentType",
  status,
  expiry_date AS "expiryDate",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function create(input: {
  documentId: string;
  versionNumber: number;
  title: string;
  description: string | null;
  fileReference: string | null;
  documentType: string;
  status: string;
  expiryDate: Date | null;
  createdByUserId: string;
}): Promise<DocumentVersionRecord> {
  const result = await getPool().query<DocumentVersionRecord>(
    `INSERT INTO document_versions
       (id, document_id, version_number, title, description, file_reference, document_type, status, expiry_date, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.documentId,
      input.versionNumber,
      input.title,
      input.description,
      input.fileReference,
      input.documentType,
      input.status,
      input.expiryDate,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

export async function findById(id: string): Promise<DocumentVersionRecord | null> {
  const result = await getPool().query<DocumentVersionRecord>(`SELECT ${SELECT} FROM document_versions WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findByDocumentAndVersion(documentId: string, versionNumber: number): Promise<DocumentVersionRecord | null> {
  const result = await getPool().query<DocumentVersionRecord>(`SELECT ${SELECT} FROM document_versions WHERE document_id = $1 AND version_number = $2`, [documentId, versionNumber]);
  return result.rows[0] ?? null;
}

export async function listByDocument(documentId: string): Promise<DocumentVersionRecord[]> {
  const result = await getPool().query<DocumentVersionRecord>(`SELECT ${SELECT} FROM document_versions WHERE document_id = $1 ORDER BY version_number ASC`, [documentId]);
  return result.rows;
}

export async function findLatestByDocument(documentId: string): Promise<DocumentVersionRecord | null> {
  const result = await getPool().query<DocumentVersionRecord>(`SELECT ${SELECT} FROM document_versions WHERE document_id = $1 ORDER BY version_number DESC LIMIT 1`, [documentId]);
  return result.rows[0] ?? null;
}

export async function getMaxVersionNumber(documentId: string): Promise<number> {
  const result = await getPool().query<{ max: string }>(`SELECT COALESCE(MAX(version_number), 0) AS max FROM document_versions WHERE document_id = $1`, [documentId]);
  return Number(result.rows[0].max);
}

export const documentVersionRepository = {
  create,
  findByDocumentAndVersion,
  findById,
  findLatestByDocument,
  getMaxVersionNumber,
  listByDocument,
};

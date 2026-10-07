import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { SupportingDocumentFilters, SupportingDocumentRecord } from './supporting-document.types';

const SELECT = `
  sd.id,
  sd.document_id AS "documentId",
  sd.parent_type AS "parentType",
  sd.parent_id AS "parentId",
  sd.client_id AS "clientId",
  sd.building_id AS "buildingId",
  sd.context_type AS "contextType",
  sd.created_by_user_id AS "createdByUserId",
  sd.created_at AS "createdAt",
  sd.updated_at AS "updatedAt"
`;

// INSERT ... RETURNING cannot reference the table alias; use unaliased columns.
const RETURNING = `
  id,
  document_id AS "documentId",
  parent_type AS "parentType",
  parent_id AS "parentId",
  client_id AS "clientId",
  building_id AS "buildingId",
  context_type AS "contextType",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function create(input: {
  documentId: string;
  parentType: string;
  parentId: string;
  clientId: string;
  buildingId: string | null;
  contextType: string;
  createdByUserId: string;
}): Promise<SupportingDocumentRecord> {
  const result = await getPool().query<SupportingDocumentRecord>(
    `INSERT INTO supporting_documents
       (id, document_id, parent_type, parent_id, client_id, building_id, context_type, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${RETURNING}`,
    [
      randomUUID(),
      input.documentId,
      input.parentType,
      input.parentId,
      input.clientId,
      input.buildingId,
      input.contextType,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

export async function findById(id: string): Promise<SupportingDocumentRecord | null> {
  const result = await getPool().query<SupportingDocumentRecord>(`SELECT ${SELECT} FROM supporting_documents sd WHERE sd.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findByDocumentId(documentId: string): Promise<SupportingDocumentRecord | null> {
  const result = await getPool().query<SupportingDocumentRecord>(`SELECT ${SELECT} FROM supporting_documents sd WHERE sd.document_id = $1`, [documentId]);
  return result.rows[0] ?? null;
}

export async function list(
  filters: SupportingDocumentFilters,
  accessibleBuildingIds: string[],
  accessibleClientIds: string[],
): Promise<SupportingDocumentRecord[]> {
  if (accessibleBuildingIds.length === 0 && accessibleClientIds.length === 0) return [];
  const values: unknown[] = [];
  const clauses: string[] = [];

  values.push(accessibleBuildingIds);
  const buildingListParam = `$${values.length}`;
  values.push(accessibleClientIds);
  const clientListParam = `$${values.length}`;
  clauses.push(`(
    (sd.building_id = ANY(${buildingListParam}::uuid[]))
    OR (sd.building_id IS NULL AND sd.client_id = ANY(${clientListParam}::uuid[]))
  )`);

  if (filters.clientId) { values.push(filters.clientId); clauses.push(`sd.client_id = $${values.length}`); }
  if (filters.buildingId) { values.push(filters.buildingId); clauses.push(`sd.building_id = $${values.length}`); }
  if (filters.parentType) { values.push(filters.parentType); clauses.push(`sd.parent_type = $${values.length}`); }
  if (filters.parentId) { values.push(filters.parentId); clauses.push(`sd.parent_id = $${values.length}`); }
  if (filters.contextType) { values.push(filters.contextType); clauses.push(`sd.context_type = $${values.length}`); }

  let join = '';
  if (filters.documentType) {
    join = ' JOIN documents d ON d.id = sd.document_id';
    values.push(filters.documentType);
    clauses.push(`d.document_type = $${values.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await getPool().query<SupportingDocumentRecord>(`SELECT ${SELECT} FROM supporting_documents sd${join} ${where} ORDER BY sd.created_at DESC`, values);
  return result.rows;
}

export const supportingDocumentRepository = {
  create,
  findByDocumentId,
  findById,
  list,
};

import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  DocumentFilters,
  DocumentRecord,
  NewDocument,
  UpdateDocumentInput,
} from './document.types';

const SELECT = `
  id,
  client_id AS "clientId",
  building_id AS "buildingId",
  document_number AS "documentNumber",
  document_type AS "documentType",
  context_type AS "contextType",
  source_type AS "sourceType",
  source_id AS "sourceId",
  title,
  description,
  file_reference AS "fileReference",
  status,
  expiry_date AS "expiryDate",
  archived_at AS "archivedAt",
  archived_by_user_id AS "archivedByUserId",
  archive_reason AS "archiveReason",
  status_before_archive AS "statusBeforeArchive",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(input: NewDocument): Promise<DocumentRecord> {
  const result = await getPool().query<DocumentRecord>(
    `INSERT INTO documents
       (id, client_id, building_id, document_number, document_type, context_type,
        source_type, source_id, title, description, file_reference, status, expiry_date, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.buildingId,
      input.documentNumber,
      input.documentType,
      input.contextType,
      input.sourceType,
      input.sourceId,
      input.title,
      input.description,
      input.fileReference,
      input.status,
      input.expiryDate,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<DocumentRecord | null> {
  const result = await getPool().query<DocumentRecord>(
    `SELECT ${SELECT} FROM documents WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function isCanonicalBastDocument(id: string): Promise<boolean> {
  const result = await getPool().query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM bast_documents WHERE document_id = $1
     ) AS exists`,
    [id],
  );
  return result.rows[0]?.exists ?? false;
}

async function findByClientAndNumber(
  clientId: string,
  documentNumber: string,
): Promise<DocumentRecord | null> {
  const result = await getPool().query<DocumentRecord>(
    `SELECT ${SELECT} FROM documents WHERE client_id = $1 AND document_number = $2`,
    [clientId, documentNumber],
  );
  return result.rows[0] ?? null;
}

async function list(
  filters: DocumentFilters,
  accessibleBuildingIds: string[],
  accessibleClientIds: string[],
): Promise<DocumentRecord[]> {
  // Building isolation: if no accessible context, empty
  // Document is accessible when:
  //  - building_id IS NOT NULL and building_id = ANY(accessibleBuildingIds)
  //  - OR building_id IS NULL and client_id = ANY(accessibleClientIds)
  // For query scoping we inject accessible sets; when filters narrow to a specific
  // building/client, isolation is re-checked at service layer via assert*.

  const values: unknown[] = [];
  const clauses: string[] = [];

  // Isolation scope clause
  if (accessibleBuildingIds.length === 0 && accessibleClientIds.length === 0) {
    return [];
  }

  // Build isolation condition: (building_id = ANY(...) OR (building_id IS NULL AND client_id = ANY(...)))
  // Use two placeholders
  values.push(accessibleBuildingIds);
  const buildingListParam = `$${values.length}`;
  values.push(accessibleClientIds);
  const clientListParam = `$${values.length}`;
  clauses.push(
    `(
      (building_id IS NOT NULL AND building_id = ANY(${buildingListParam}::uuid[]))
      OR
      (building_id IS NULL AND client_id = ANY(${clientListParam}::uuid[]))
    )`,
  );

  if (filters.clientId) {
    values.push(filters.clientId);
    clauses.push(`client_id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    clauses.push(`building_id = $${values.length}`);
  }
  if (filters.documentType) {
    values.push(filters.documentType);
    clauses.push(`document_type = $${values.length}`);
  }
  if (filters.contextType) {
    values.push(filters.contextType);
    clauses.push(`context_type = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await getPool().query<DocumentRecord>(
    `SELECT ${SELECT} FROM documents ${where} ORDER BY created_at DESC, document_number ASC`,
    values,
  );
  return result.rows;
}

async function update(
  id: string,
  input: UpdateDocumentInput,
): Promise<DocumentRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.documentType !== undefined) {
    values.push(input.documentType);
    sets.push(`document_type = $${values.length}`);
  }
  if (input.title !== undefined) {
    values.push(input.title);
    sets.push(`title = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.fileReference !== undefined) {
    values.push(input.fileReference);
    sets.push(`file_reference = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }
  if (input.buildingId !== undefined) {
    values.push(input.buildingId);
    sets.push(`building_id = $${values.length}`);
  }
  if (input.expiryDate !== undefined) {
    values.push(input.expiryDate);
    sets.push(`expiry_date = $${values.length}`);
  }

  if (sets.length === 0) return findById(id);

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<DocumentRecord>(
    `UPDATE documents SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function archive(
  id: string,
  actorUserId: string,
  reason: string | null,
): Promise<DocumentRecord | null> {
  const result = await getPool().query<DocumentRecord>(
    `UPDATE documents
     SET status_before_archive = status,
         status = 'ARCHIVED',
         archived_at = NOW(),
         archived_by_user_id = $2,
         archive_reason = $3,
         updated_at = NOW()
     WHERE id = $1 AND status <> 'ARCHIVED'
     RETURNING ${SELECT}`,
    [id, actorUserId, reason],
  );
  return result.rows[0] ?? null;
}

async function restore(id: string): Promise<DocumentRecord | null> {
  const result = await getPool().query<DocumentRecord>(
    `UPDATE documents
     SET status = status_before_archive,
         archived_at = NULL,
         archived_by_user_id = NULL,
         archive_reason = NULL,
         status_before_archive = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND status = 'ARCHIVED'
       AND status_before_archive IN ('DRAFT', 'ACTIVE', 'INACTIVE')
     RETURNING ${SELECT}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export const documentRepository = {
  create,
  findById,
  findByClientAndNumber,
  isCanonicalBastDocument,
  list,
  update,
  archive,
  restore,
};

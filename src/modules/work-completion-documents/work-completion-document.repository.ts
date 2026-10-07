import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  WorkCompletionDocumentFilters,
  WorkCompletionDocumentRecord,
} from './work-completion-document.types';

const SELECT = `
  wcd.id,
  wcd.document_id AS "documentId",
  wcd.work_order_id AS "workOrderId",
  wcd.vendor_work_id AS "vendorWorkId",
  wcd.client_id AS "clientId",
  wcd.building_id AS "buildingId",
  wcd.context_type AS "contextType",
  wcd.created_by_user_id AS "createdByUserId",
  wcd.created_at AS "createdAt",
  wcd.updated_at AS "updatedAt"
`;

// INSERT ... RETURNING cannot reference the table alias; use unaliased columns.
const RETURNING = `
  id,
  document_id AS "documentId",
  work_order_id AS "workOrderId",
  vendor_work_id AS "vendorWorkId",
  client_id AS "clientId",
  building_id AS "buildingId",
  context_type AS "contextType",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function create(input: {
  documentId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  clientId: string;
  buildingId: string;
  contextType: string;
  createdByUserId: string;
}): Promise<WorkCompletionDocumentRecord> {
  const result = await getPool().query<WorkCompletionDocumentRecord>(
    `INSERT INTO work_completion_documents
       (id, document_id, work_order_id, vendor_work_id, client_id, building_id, context_type, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING ${RETURNING}`,
    [
      randomUUID(),
      input.documentId,
      input.workOrderId,
      input.vendorWorkId,
      input.clientId,
      input.buildingId,
      input.contextType,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

export async function findById(id: string): Promise<WorkCompletionDocumentRecord | null> {
  const result = await getPool().query<WorkCompletionDocumentRecord>(
    `SELECT ${SELECT} FROM work_completion_documents wcd WHERE wcd.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findByDocumentId(documentId: string): Promise<WorkCompletionDocumentRecord | null> {
  const result = await getPool().query<WorkCompletionDocumentRecord>(
    `SELECT ${SELECT} FROM work_completion_documents wcd WHERE wcd.document_id = $1`,
    [documentId],
  );
  return result.rows[0] ?? null;
}

export async function findByWorkOrderId(workOrderId: string): Promise<WorkCompletionDocumentRecord[]> {
  const result = await getPool().query<WorkCompletionDocumentRecord>(
    `SELECT ${SELECT} FROM work_completion_documents wcd WHERE wcd.work_order_id = $1 ORDER BY wcd.created_at DESC`,
    [workOrderId],
  );
  return result.rows;
}

export async function list(
  filters: WorkCompletionDocumentFilters,
  accessibleBuildingIds: string[],
  accessibleClientIds: string[],
): Promise<WorkCompletionDocumentRecord[]> {
  if (accessibleBuildingIds.length === 0 && accessibleClientIds.length === 0) return [];

  const values: unknown[] = [];
  const clauses: string[] = [];

  // Isolation: building scope
  values.push(accessibleBuildingIds);
  const buildingListParam = `$${values.length}`;
  values.push(accessibleClientIds);
  const clientListParam = `$${values.length}`;
  clauses.push(`(
    (wcd.building_id = ANY(${buildingListParam}::uuid[]))
    OR
    (wcd.building_id IS NULL AND wcd.client_id = ANY(${clientListParam}::uuid[]))
  )`);

  if (filters.clientId) {
    values.push(filters.clientId);
    clauses.push(`wcd.client_id = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    clauses.push(`wcd.building_id = $${values.length}`);
  }
  if (filters.workOrderId) {
    values.push(filters.workOrderId);
    clauses.push(`wcd.work_order_id = $${values.length}`);
  }
  if (filters.vendorWorkId) {
    values.push(filters.vendorWorkId);
    clauses.push(`wcd.vendor_work_id = $${values.length}`);
  }
  if (filters.contextType) {
    values.push(filters.contextType);
    clauses.push(`wcd.context_type = $${values.length}`);
  }
  // documentType and status are on documents table — join needed when filtering those
  let join = '';
  if (filters.documentType || filters.status) {
    join = ' JOIN documents d ON d.id = wcd.document_id';
    if (filters.documentType) {
      values.push(filters.documentType);
      clauses.push(`d.document_type = $${values.length}`);
    }
    if (filters.status) {
      values.push(filters.status);
      clauses.push(`d.status = $${values.length}`);
    }
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await getPool().query<WorkCompletionDocumentRecord>(
    `SELECT ${SELECT} FROM work_completion_documents wcd${join} ${where} ORDER BY wcd.created_at DESC`,
    values,
  );
  return result.rows;
}

export const workCompletionDocumentRepository = {
  create,
  findByDocumentId,
  findById,
  findByWorkOrderId,
  list,
};

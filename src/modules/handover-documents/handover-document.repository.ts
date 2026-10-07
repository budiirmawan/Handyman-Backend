import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { HandoverDocumentFilters, HandoverDocumentRecord } from './handover-document.types';

const SELECT = `
  hd.id,
  hd.document_id AS "documentId",
  hd.work_order_id AS "workOrderId",
  hd.vendor_work_id AS "vendorWorkId",
  hd.work_completion_document_id AS "workCompletionDocumentId",
  hd.bast_document_id AS "bastDocumentId",
  hd.client_id AS "clientId",
  hd.building_id AS "buildingId",
  hd.context_type AS "contextType",
  hd.handover_number AS "handoverNumber",
  hd.handover_date AS "handoverDate",
  hd.handover_status AS "handoverStatus",
  hd.notes,
  hd.file_reference AS "fileReference",
  hd.prepared_by_user_id AS "preparedByUserId",
  hd.handed_over_by_user_id AS "handedOverByUserId",
  hd.handed_over_at AS "handedOverAt",
  hd.created_at AS "createdAt",
  hd.updated_at AS "updatedAt"
`;

// INSERT ... RETURNING cannot reference the table alias; use unaliased columns.
const RETURNING = `
  id,
  document_id AS "documentId",
  work_order_id AS "workOrderId",
  vendor_work_id AS "vendorWorkId",
  work_completion_document_id AS "workCompletionDocumentId",
  bast_document_id AS "bastDocumentId",
  client_id AS "clientId",
  building_id AS "buildingId",
  context_type AS "contextType",
  handover_number AS "handoverNumber",
  handover_date AS "handoverDate",
  handover_status AS "handoverStatus",
  notes,
  file_reference AS "fileReference",
  prepared_by_user_id AS "preparedByUserId",
  handed_over_by_user_id AS "handedOverByUserId",
  handed_over_at AS "handedOverAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function toDateString(v: string | Date): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
function mapRow(row: any): HandoverDocumentRecord {
  return { ...row, handoverDate: toDateString(row.handoverDate) };
}

export async function create(input: {
  documentId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  workCompletionDocumentId: string | null;
  bastDocumentId: string | null;
  clientId: string;
  buildingId: string;
  contextType: string;
  handoverNumber: string;
  handoverDate: string;
  notes: string | null;
  fileReference: string | null;
  preparedByUserId: string;
}): Promise<HandoverDocumentRecord> {
  const result = await getPool().query(
    `INSERT INTO handover_documents
       (id, document_id, work_order_id, vendor_work_id, work_completion_document_id, bast_document_id,
        client_id, building_id, context_type, handover_number, handover_date, notes, file_reference, prepared_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${RETURNING}`,
    [
      randomUUID(),
      input.documentId,
      input.workOrderId,
      input.vendorWorkId,
      input.workCompletionDocumentId,
      input.bastDocumentId,
      input.clientId,
      input.buildingId,
      input.contextType,
      input.handoverNumber,
      input.handoverDate,
      input.notes,
      input.fileReference,
      input.preparedByUserId,
    ],
  );
  return mapRow(result.rows[0]);
}

export async function findById(id: string): Promise<HandoverDocumentRecord | null> {
  const result = await getPool().query(`SELECT ${SELECT} FROM handover_documents hd WHERE hd.id = $1`, [id]);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}
export async function findByDocumentId(documentId: string): Promise<HandoverDocumentRecord | null> {
  const result = await getPool().query(`SELECT ${SELECT} FROM handover_documents hd WHERE hd.document_id = $1`, [documentId]);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}
export async function findByHandoverNumber(clientId: string, handoverNumber: string): Promise<HandoverDocumentRecord | null> {
  const result = await getPool().query(`SELECT ${SELECT} FROM handover_documents hd WHERE hd.client_id = $1 AND hd.handover_number = $2`, [clientId, handoverNumber]);
  const row = result.rows[0];
  return row ? mapRow(row) : null;
}
export async function list(
  filters: HandoverDocumentFilters,
  accessibleBuildingIds: string[],
  accessibleClientIds: string[],
): Promise<HandoverDocumentRecord[]> {
  if (accessibleBuildingIds.length === 0 && accessibleClientIds.length === 0) return [];
  const values: unknown[] = [];
  const clauses: string[] = [];

  values.push(accessibleBuildingIds);
  const buildingListParam = `$${values.length}`;
  values.push(accessibleClientIds);
  const clientListParam = `$${values.length}`;
  clauses.push(`(
    (hd.building_id = ANY(${buildingListParam}::uuid[]))
    OR (hd.building_id IS NULL AND hd.client_id = ANY(${clientListParam}::uuid[]))
  )`);

  if (filters.clientId) { values.push(filters.clientId); clauses.push(`hd.client_id = $${values.length}`); }
  if (filters.buildingId) { values.push(filters.buildingId); clauses.push(`hd.building_id = $${values.length}`); }
  if (filters.workOrderId) { values.push(filters.workOrderId); clauses.push(`hd.work_order_id = $${values.length}`); }
  if (filters.vendorWorkId) { values.push(filters.vendorWorkId); clauses.push(`hd.vendor_work_id = $${values.length}`); }
  if (filters.workCompletionDocumentId) { values.push(filters.workCompletionDocumentId); clauses.push(`hd.work_completion_document_id = $${values.length}`); }
  if (filters.bastDocumentId) { values.push(filters.bastDocumentId); clauses.push(`hd.bast_document_id = $${values.length}`); }
  if (filters.contextType) { values.push(filters.contextType); clauses.push(`hd.context_type = $${values.length}`); }
  if (filters.handoverStatus) { values.push(filters.handoverStatus); clauses.push(`hd.handover_status = $${values.length}`); }
  if (filters.handoverNumber) { values.push(filters.handoverNumber); clauses.push(`hd.handover_number = $${values.length}`); }
  // status on documents table requires join if needed — for now filter via documents if status provided
  let join = '';
  if (filters.status) {
    join = ' JOIN documents d ON d.id = hd.document_id';
    values.push(filters.status);
    clauses.push(`d.status = $${values.length}`);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await getPool().query(`SELECT ${SELECT} FROM handover_documents hd${join} ${where} ORDER BY hd.created_at DESC`, values);
  return result.rows.map(mapRow);
}

export const handoverDocumentRepository = {
  create,
  findByDocumentId,
  findByHandoverNumber,
  findById,
  list,
};

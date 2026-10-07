import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorComplianceDocument,
  UpdateVendorComplianceDocumentInput,
  VendorComplianceDocumentRecord,
  VendorComplianceDocumentStatus,
} from './vendor-compliance-document.types';

type VendorComplianceDocumentRow = {
  id: string;
  vendor_id: string;
  document_type: string;
  document_number: string;
  document_name: string;
  issue_date: Date | null;
  expiry_date: Date | null;
  status: VendorComplianceDocumentStatus;
  file_reference: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

const DOCUMENT_SELECT = `
  id,
  vendor_id,
  document_type,
  document_number,
  document_name,
  issue_date,
  expiry_date,
  status,
  file_reference,
  notes,
  created_at,
  updated_at
`;

function mapRow(
  row: VendorComplianceDocumentRow,
): VendorComplianceDocumentRecord {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    documentType: row.document_type,
    documentNumber: row.document_number,
    documentName: row.document_name,
    issueDate: row.issue_date,
    expiryDate: row.expiry_date,
    status: row.status,
    fileReference: row.file_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(
  input: NewVendorComplianceDocument,
): Promise<VendorComplianceDocumentRecord> {
  const result = await getPool().query<VendorComplianceDocumentRow>(
    `INSERT INTO vendor_compliance_documents
       (id, vendor_id, document_type, document_number, document_name,
        issue_date, expiry_date, status, file_reference, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING ${DOCUMENT_SELECT}`,
    [
      randomUUID(),
      input.vendorId,
      input.documentType,
      input.documentNumber,
      input.documentName,
      input.issueDate,
      input.expiryDate,
      input.status,
      input.fileReference,
      input.notes,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
): Promise<VendorComplianceDocumentRecord | null> {
  const result = await getPool().query<VendorComplianceDocumentRow>(
    `SELECT ${DOCUMENT_SELECT} FROM vendor_compliance_documents WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Every compliance document of one Vendor, history included. */
async function listByVendorId(
  vendorId: string,
): Promise<VendorComplianceDocumentRecord[]> {
  const result = await getPool().query<VendorComplianceDocumentRow>(
    `SELECT ${DOCUMENT_SELECT} FROM vendor_compliance_documents
     WHERE vendor_id = $1
     ORDER BY document_type ASC, document_number ASC, created_at ASC`,
    [vendorId],
  );

  return result.rows.map(mapRow);
}

async function findActiveByTypeAndNumber(
  vendorId: string,
  documentType: string,
  documentNumber: string,
): Promise<VendorComplianceDocumentRecord | null> {
  const result = await getPool().query<VendorComplianceDocumentRow>(
    `SELECT ${DOCUMENT_SELECT} FROM vendor_compliance_documents
     WHERE vendor_id = $1
       AND document_type = $2
       AND document_number = $3
       AND status = 'ACTIVE'`,
    [vendorId, documentType, documentNumber],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function update(
  id: string,
  input: UpdateVendorComplianceDocumentInput,
): Promise<VendorComplianceDocumentRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.documentType !== undefined) {
    values.push(input.documentType);
    sets.push(`document_type = $${values.length}`);
  }
  if (input.documentNumber !== undefined) {
    values.push(input.documentNumber);
    sets.push(`document_number = $${values.length}`);
  }
  if (input.documentName !== undefined) {
    values.push(input.documentName);
    sets.push(`document_name = $${values.length}`);
  }
  if (input.issueDate !== undefined) {
    values.push(input.issueDate);
    sets.push(`issue_date = $${values.length}`);
  }
  if (input.expiryDate !== undefined) {
    values.push(input.expiryDate);
    sets.push(`expiry_date = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }
  if (input.fileReference !== undefined) {
    values.push(input.fileReference);
    sets.push(`file_reference = $${values.length}`);
  }
  if (input.notes !== undefined) {
    values.push(input.notes);
    sets.push(`notes = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<VendorComplianceDocumentRow>(
    `UPDATE vendor_compliance_documents SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${DOCUMENT_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const vendorComplianceDocumentRepository = {
  create,
  findActiveByTypeAndNumber,
  findById,
  listByVendorId,
  update,
};

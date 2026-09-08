import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTenantDocument,
  TenantDocumentFilters,
  TenantDocumentRecord,
  UpdateTenantDocumentInput,
} from './tenant-document.types';

const SELECT = `id, client_id AS "clientId",
  tenant_company_id AS "tenantCompanyId", building_id AS "buildingId",
  document_type AS "documentType", document_name AS "documentName",
  document_number AS "documentNumber", issue_date AS "issueDate",
  expiry_date AS "expiryDate", file_reference AS "fileReference",
  status, notes, created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewTenantDocument): Promise<TenantDocumentRecord> {
  const result = await getPool().query<TenantDocumentRecord>(
    `INSERT INTO tenant_documents
       (id, client_id, tenant_company_id, building_id, document_type,
        document_name, document_number, issue_date, expiry_date,
        file_reference, status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.tenantCompanyId, input.buildingId,
      input.documentType, input.documentName, input.documentNumber,
      input.issueDate, input.expiryDate, input.fileReference, input.status,
      input.notes],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantDocumentRecord | null> {
  const result = await getPool().query<TenantDocumentRecord>(
    `SELECT ${SELECT} FROM tenant_documents WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findActiveDuplicate(input: {
  tenantCompanyId: string;
  buildingId: string | null;
  documentType: string;
  documentNumber: string;
}): Promise<TenantDocumentRecord | null> {
  const result = await getPool().query<TenantDocumentRecord>(
    `SELECT ${SELECT} FROM tenant_documents
     WHERE tenant_company_id = $1 AND building_id IS NOT DISTINCT FROM $2
       AND document_type = $3 AND document_number = $4 AND status = 'ACTIVE'`,
    [input.tenantCompanyId, input.buildingId, input.documentType,
      input.documentNumber],
  );
  return result.rows[0] ?? null;
}

async function expireDueById(id: string): Promise<void> {
  await getPool().query(
    `UPDATE tenant_documents SET status = 'EXPIRED', updated_at = NOW()
     WHERE id = $1 AND status = 'ACTIVE' AND expiry_date < NOW()`,
    [id],
  );
}

async function expireDueByTenant(tenantCompanyId: string): Promise<void> {
  await getPool().query(
    `UPDATE tenant_documents SET status = 'EXPIRED', updated_at = NOW()
     WHERE tenant_company_id = $1 AND status = 'ACTIVE' AND expiry_date < NOW()`,
    [tenantCompanyId],
  );
}

async function listByTenant(
  tenantCompanyId: string,
  filters: TenantDocumentFilters,
  buildingIds: string[],
): Promise<TenantDocumentRecord[]> {
  const values: unknown[] = [tenantCompanyId, buildingIds];
  const clauses = [
    'tenant_company_id = $1',
    '(building_id IS NULL OR building_id = ANY($2::uuid[]))',
  ];
  if (filters.documentType) {
    values.push(filters.documentType);
    clauses.push(`document_type = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filters.buildingId) {
    values.push(filters.buildingId);
    clauses.push(`building_id = $${values.length}`);
  }
  const result = await getPool().query<TenantDocumentRecord>(
    `SELECT ${SELECT} FROM tenant_documents
     WHERE ${clauses.join(' AND ')} ORDER BY document_type, created_at`, values,
  );
  return result.rows;
}

async function update(id: string, input: UpdateTenantDocumentInput): Promise<TenantDocumentRecord | null> {
  const values: unknown[] = [];
  const sets: string[] = [];
  const fields: [keyof UpdateTenantDocumentInput, string][] = [
    ['documentType', 'document_type'], ['documentName', 'document_name'],
    ['documentNumber', 'document_number'], ['issueDate', 'issue_date'],
    ['expiryDate', 'expiry_date'], ['fileReference', 'file_reference'],
    ['status', 'status'], ['notes', 'notes'],
  ];
  for (const [key, column] of fields) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<TenantDocumentRecord>(
    `UPDATE tenant_documents SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`, values,
  );
  return result.rows[0] ?? null;
}

export const tenantDocumentRepository = {
  create,
  expireDueById,
  expireDueByTenant,
  findActiveDuplicate,
  findById,
  listByTenant,
  update,
};

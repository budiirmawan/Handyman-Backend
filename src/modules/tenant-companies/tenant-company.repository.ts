import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CreateTenantCompanyInput,
  TenantCompanyListFilters,
  TenantCompanyRecord,
  TenantCompanyStatus,
  UpdateTenantCompanyInput,
} from './tenant-company.types';

const SELECT = `id, client_id AS "clientId", tenant_code AS "tenantCode",
  tenant_name AS "tenantName", party_kind AS "partyKind",
  legal_name AS "legalName",
  identity_document_type AS "identityDocumentType",
  identity_document_number AS "identityDocumentNumber",
  email, phone, address,
  status, created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: CreateTenantCompanyInput): Promise<TenantCompanyRecord> {
  const result = await getPool().query<TenantCompanyRecord>(
    `INSERT INTO tenant_companies
       (id, client_id, tenant_code, tenant_name, party_kind, legal_name,
        identity_document_type, identity_document_number,
        email, phone, address, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${SELECT}`,
    [randomUUID(), input.clientId, input.tenantCode, input.tenantName,
      input.partyKind ?? 'LEGAL_ENTITY', input.legalName ?? null,
      input.identityDocumentType ?? null, input.identityDocumentNumber ?? null,
      input.email ?? null, input.phone ?? null,
      input.address ?? null, input.status ?? 'ACTIVE'],
  );
  return result.rows[0];
}

async function findById(id: string): Promise<TenantCompanyRecord | null> {
  const result = await getPool().query<TenantCompanyRecord>(
    `SELECT ${SELECT} FROM tenant_companies WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findByCodeForClient(clientId: string, tenantCode: string): Promise<TenantCompanyRecord | null> {
  const result = await getPool().query<TenantCompanyRecord>(
    `SELECT ${SELECT} FROM tenant_companies WHERE client_id = $1 AND tenant_code = $2`,
    [clientId, tenantCode],
  );
  return result.rows[0] ?? null;
}

async function findByIdentityDocument(
  clientId: string,
  type: string,
  number: string,
): Promise<TenantCompanyRecord | null> {
  const result = await getPool().query<TenantCompanyRecord>(
    `SELECT ${SELECT} FROM tenant_companies
      WHERE client_id = $1 AND identity_document_type = $2
        AND identity_document_number = $3`,
    [clientId, type, number],
  );
  return result.rows[0] ?? null;
}

async function listByClient(clientId: string, filters: TenantCompanyListFilters): Promise<TenantCompanyRecord[]> {
  const clauses = ['client_id = $1'];
  const values: unknown[] = [clientId];
  if (filters.status) {
    values.push(filters.status);
    clauses.push(`status = $${values.length}`);
  }
  if (filters.partyKind) {
    values.push(filters.partyKind);
    clauses.push(`party_kind = $${values.length}`);
  }
  if (filters.search) {
    values.push(`%${filters.search.replace(/[\\%_]/g, '\\$&')}%`);
    clauses.push(`(tenant_code ILIKE $${values.length} ESCAPE '\\' OR tenant_name ILIKE $${values.length} ESCAPE '\\' OR legal_name ILIKE $${values.length} ESCAPE '\\' OR identity_document_number ILIKE $${values.length} ESCAPE '\\')`);
  }
  const result = await getPool().query<TenantCompanyRecord>(
    `SELECT ${SELECT} FROM tenant_companies WHERE ${clauses.join(' AND ')} ORDER BY tenant_code ASC`,
    values,
  );
  return result.rows;
}

async function update(id: string, input: UpdateTenantCompanyInput): Promise<TenantCompanyRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];
  const columns: [keyof UpdateTenantCompanyInput, string][] = [
    ['tenantName', 'tenant_name'], ['legalName', 'legal_name'],
    ['identityDocumentType', 'identity_document_type'],
    ['identityDocumentNumber', 'identity_document_number'],
    ['email', 'email'], ['phone', 'phone'], ['address', 'address'],
    ['status', 'status'],
  ];
  for (const [key, column] of columns) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');
  const result = await getPool().query<TenantCompanyRecord>(
    `UPDATE tenant_companies SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

export const tenantCompanyRepository = {
  create,
  findByCodeForClient,
  findById,
  findByIdentityDocument,
  listByClient,
  update,
};

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, withTransaction } from '../../database';
import type {
  NewTenantPic,
  TenantPicRecord,
  UpdateTenantPicInput,
} from './tenant-pic.types';
import type { TenantVerificationStatus } from '../tenant-companies/tenant-company.types';

const SELECT = `id, tenant_company_id AS "tenantCompanyId",
  user_id AS "userId", pic_name AS "picName", email, phone,
  role_title AS "roleTitle", is_primary AS "isPrimary", status,
  verification_status AS "verificationStatus",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

/** Serialize primary-contact changes without blocking approval's FK KEY SHARE. */
async function lockCompany(tenantCompanyId: string, client: PoolClient): Promise<void> {
  await client.query('SELECT id FROM tenant_companies WHERE id = $1 FOR NO KEY UPDATE', [tenantCompanyId]);
}

async function create(input: NewTenantPic, client?: PoolClient): Promise<TenantPicRecord> {
  if (!client) return withTransaction((tx) => create(input, tx));
  await lockCompany(input.tenantCompanyId, client);
  if (input.isPrimary) {
    await client.query(
      `UPDATE tenant_pics SET is_primary = FALSE, updated_at = NOW()
       WHERE tenant_company_id = $1 AND is_primary`,
      [input.tenantCompanyId],
    );
  }
  const result = await client.query<TenantPicRecord>(
    `INSERT INTO tenant_pics
       (id, tenant_company_id, user_id, pic_name, email, phone,
        role_title, is_primary, status, verification_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING ${SELECT}`,
    [randomUUID(), input.tenantCompanyId, input.userId, input.picName,
      input.email, input.phone, input.roleTitle, input.isPrimary, input.status,
      input.verificationStatus ?? 'VERIFIED'],
  );
  return result.rows[0];
}

async function findById(id: string, client?: PoolClient): Promise<TenantPicRecord | null> {
  const result = await (client ?? getPool()).query<TenantPicRecord>(
    `SELECT ${SELECT} FROM tenant_pics WHERE id = $1`, [id],
  );
  return result.rows[0] ?? null;
}

async function findByIdForUpdate(id: string, client: PoolClient): Promise<TenantPicRecord | null> {
  const result = await client.query<TenantPicRecord>(
    `SELECT ${SELECT} FROM tenant_pics WHERE id = $1 FOR UPDATE`, [id],
  );
  return result.rows[0] ?? null;
}

async function listByTenantCompany(tenantCompanyId: string): Promise<TenantPicRecord[]> {
  const result = await getPool().query<TenantPicRecord>(
    `SELECT ${SELECT} FROM tenant_pics WHERE tenant_company_id = $1
     ORDER BY is_primary DESC, pic_name ASC, created_at ASC`,
    [tenantCompanyId],
  );
  return result.rows;
}

async function update(
  id: string,
  tenantCompanyId: string,
  input: UpdateTenantPicInput,
  client?: PoolClient,
): Promise<TenantPicRecord | null> {
  if (!client) return withTransaction((tx) => update(id, tenantCompanyId, input, tx));
  const values: unknown[] = [];
  const sets: string[] = [];
  const columns: [keyof UpdateTenantPicInput, string][] = [
    ['userId', 'user_id'], ['picName', 'pic_name'], ['email', 'email'],
    ['phone', 'phone'], ['roleTitle', 'role_title'],
    ['isPrimary', 'is_primary'], ['status', 'status'],
  ];
  for (const [key, column] of columns) {
    if (input[key] !== undefined) {
      values.push(input[key]);
      sets.push(`${column} = $${values.length}`);
    }
  }
  if (sets.length === 0) return findById(id, client);
  values.push(id);
  sets.push('updated_at = NOW()');

  await lockCompany(tenantCompanyId, client);
  if (input.isPrimary === true) {
    await client.query(
      `UPDATE tenant_pics SET is_primary = FALSE, updated_at = NOW()
       WHERE tenant_company_id = $1 AND is_primary AND id <> $2`,
      [tenantCompanyId, id],
    );
  }
  const result = await client.query<TenantPicRecord>(
    `UPDATE tenant_pics SET ${sets.join(', ')}
     WHERE id = $${values.length} RETURNING ${SELECT}`,
    values,
  );
  return result.rows[0] ?? null;
}

async function setVerificationStatus(
  id: string,
  verificationStatus: TenantVerificationStatus,
): Promise<TenantPicRecord | null> {
  const result = await getPool().query<TenantPicRecord>(
    `UPDATE tenant_pics SET verification_status = $1, updated_at = NOW()
      WHERE id = $2 RETURNING ${SELECT}`,
    [verificationStatus, id],
  );
  return result.rows[0] ?? null;
}

export const tenantPicRepository = {
  create,
  findById,
  findByIdForUpdate,
  listByTenantCompany,
  lockCompany,
  setVerificationStatus,
  update,
};

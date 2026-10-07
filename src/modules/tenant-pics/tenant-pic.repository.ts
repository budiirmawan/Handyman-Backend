import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewTenantPic,
  TenantPicRecord,
  UpdateTenantPicInput,
} from './tenant-pic.types';

const SELECT = `id, tenant_company_id AS "tenantCompanyId",
  user_id AS "userId", pic_name AS "picName", email, phone,
  role_title AS "roleTitle", is_primary AS "isPrimary", status,
  created_at AS "createdAt", updated_at AS "updatedAt"`;

async function create(input: NewTenantPic): Promise<TenantPicRecord> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM tenant_companies WHERE id = $1 FOR UPDATE', [
      input.tenantCompanyId,
    ]);
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
          role_title, is_primary, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING ${SELECT}`,
      [randomUUID(), input.tenantCompanyId, input.userId, input.picName,
        input.email, input.phone, input.roleTitle, input.isPrimary, input.status],
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function findById(id: string): Promise<TenantPicRecord | null> {
  const result = await getPool().query<TenantPicRecord>(
    `SELECT ${SELECT} FROM tenant_pics WHERE id = $1`, [id],
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
): Promise<TenantPicRecord | null> {
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
  if (sets.length === 0) return findById(id);
  values.push(id);
  sets.push('updated_at = NOW()');

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM tenant_companies WHERE id = $1 FOR UPDATE', [
      tenantCompanyId,
    ]);
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
    await client.query('COMMIT');
    return result.rows[0] ?? null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const tenantPicRepository = { create, findById, listByTenantCompany, update };

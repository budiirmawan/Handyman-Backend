import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorCategory,
  UpdateVendorCategoryInput,
  VendorCategoryRecord,
  VendorCategoryStatus,
} from './vendor-category.types';

type VendorCategoryRow = {
  id: string;
  clientId: string;
  code: string;
  name: string;
  description: string | null;
  status: VendorCategoryStatus;
  createdAt: Date;
  updatedAt: Date;
};

const VENDOR_CATEGORY_SELECT = `
  id,
  client_id AS "clientId",
  code,
  name,
  description,
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapVendorCategoryRow(row: VendorCategoryRow): VendorCategoryRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createVendorCategory(
  input: NewVendorCategory,
): Promise<VendorCategoryRecord> {
  const result = await getPool().query<VendorCategoryRow>(
    `INSERT INTO vendor_categories
       (id, client_id, code, name, description, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${VENDOR_CATEGORY_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.code,
      input.name,
      input.description,
      input.status,
    ],
  );

  return mapVendorCategoryRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorCategoryRecord | null> {
  const result = await getPool().query<VendorCategoryRow>(
    `SELECT ${VENDOR_CATEGORY_SELECT} FROM vendor_categories WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapVendorCategoryRow(row) : null;
}

async function findByCodeForClient(
  clientId: string,
  code: string,
): Promise<VendorCategoryRecord | null> {
  const result = await getPool().query<VendorCategoryRow>(
    `SELECT ${VENDOR_CATEGORY_SELECT} FROM vendor_categories
     WHERE client_id = $1 AND code = $2`,
    [clientId, code],
  );

  const row = result.rows[0];
  return row ? mapVendorCategoryRow(row) : null;
}

async function listByClient(
  clientId: string,
): Promise<VendorCategoryRecord[]> {
  const result = await getPool().query<VendorCategoryRow>(
    `SELECT ${VENDOR_CATEGORY_SELECT} FROM vendor_categories
     WHERE client_id = $1 ORDER BY code ASC`,
    [clientId],
  );

  return result.rows.map(mapVendorCategoryRow);
}

async function updateVendorCategory(
  id: string,
  input: UpdateVendorCategoryInput,
): Promise<VendorCategoryRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.description !== undefined) {
    values.push(input.description);
    sets.push(`description = $${values.length}`);
  }
  if (input.status !== undefined) {
    values.push(input.status);
    sets.push(`status = $${values.length}`);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<VendorCategoryRow>(
    `UPDATE vendor_categories SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${VENDOR_CATEGORY_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapVendorCategoryRow(row) : null;
}

async function updateStatus(
  id: string,
  status: VendorCategoryStatus,
): Promise<VendorCategoryRecord | null> {
  const result = await getPool().query<VendorCategoryRow>(
    `UPDATE vendor_categories SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${VENDOR_CATEGORY_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapVendorCategoryRow(row) : null;
}

export const vendorCategoryRepository = {
  createVendorCategory,
  findByCodeForClient,
  findById,
  listByClient,
  updateStatus,
  updateVendorCategory,
};

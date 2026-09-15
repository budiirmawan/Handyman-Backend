import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorPic,
  UpdateVendorPicInput,
  VendorPicRecord,
  VendorPicStatus,
} from './vendor-pic.types';

type VendorPicRow = {
  id: string;
  vendorId: string;
  name: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  isPrimary: boolean;
  status: VendorPicStatus;
  createdAt: Date;
  updatedAt: Date;
};

const VENDOR_PIC_SELECT = `
  id,
  vendor_id AS "vendorId",
  name,
  position,
  email,
  phone,
  is_primary AS "isPrimary",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapVendorPicRow(row: VendorPicRow): VendorPicRecord {
  return {
    id: row.id,
    vendorId: row.vendorId,
    name: row.name,
    position: row.position,
    email: row.email,
    phone: row.phone,
    isPrimary: row.isPrimary,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Inserts a PIC. When the new PIC is primary, the current primary of the
 * Vendor (if any) is demoted first — both statements run in one transaction
 * so the partial unique index (`vendor_pics_primary_unique`) is never
 * violated mid-flight.
 */
async function createVendorPic(input: NewVendorPic): Promise<VendorPicRecord> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    if (input.isPrimary) {
      await client.query(
        `UPDATE vendor_pics SET is_primary = FALSE, updated_at = NOW()
         WHERE vendor_id = $1 AND is_primary`,
        [input.vendorId],
      );
    }

    const result = await client.query<VendorPicRow>(
      `INSERT INTO vendor_pics
         (id, vendor_id, name, position, email, phone, is_primary, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${VENDOR_PIC_SELECT}`,
      [
        randomUUID(),
        input.vendorId,
        input.name,
        input.position,
        input.email,
        input.phone,
        input.isPrimary,
        input.status,
      ],
    );

    await client.query('COMMIT');
    return mapVendorPicRow(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function findById(id: string): Promise<VendorPicRecord | null> {
  const result = await getPool().query<VendorPicRow>(
    `SELECT ${VENDOR_PIC_SELECT} FROM vendor_pics WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapVendorPicRow(row) : null;
}

async function listByVendor(vendorId: string): Promise<VendorPicRecord[]> {
  const result = await getPool().query<VendorPicRow>(
    `SELECT ${VENDOR_PIC_SELECT} FROM vendor_pics
     WHERE vendor_id = $1
     ORDER BY is_primary DESC, name ASC, created_at ASC`,
    [vendorId],
  );

  return result.rows.map(mapVendorPicRow);
}

/**
 * Partially updates a PIC. When the update promotes the PIC to primary, the
 * Vendor's current primary (if a different row) is demoted in the same
 * transaction.
 */
async function updateVendorPic(
  id: string,
  vendorId: string,
  input: UpdateVendorPicInput,
): Promise<VendorPicRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.position !== undefined) {
    values.push(input.position);
    sets.push(`position = $${values.length}`);
  }
  if (input.email !== undefined) {
    values.push(input.email);
    sets.push(`email = $${values.length}`);
  }
  if (input.phone !== undefined) {
    values.push(input.phone);
    sets.push(`phone = $${values.length}`);
  }
  if (input.isPrimary !== undefined) {
    values.push(input.isPrimary);
    sets.push(`is_primary = $${values.length}`);
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

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    if (input.isPrimary === true) {
      await client.query(
        `UPDATE vendor_pics SET is_primary = FALSE, updated_at = NOW()
         WHERE vendor_id = $1 AND is_primary AND id <> $2`,
        [vendorId, id],
      );
    }

    const result = await client.query<VendorPicRow>(
      `UPDATE vendor_pics SET ${sets.join(', ')}
        WHERE id = $${values.length}
        RETURNING ${VENDOR_PIC_SELECT}`,
      values,
    );

    await client.query('COMMIT');
    const row = result.rows[0];
    return row ? mapVendorPicRow(row) : null;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export const vendorPicRepository = {
  createVendorPic,
  findById,
  listByVendor,
  updateVendorPic,
};

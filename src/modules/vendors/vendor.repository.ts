import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendor,
  UpdateVendorInput,
  VendorRecord,
  VendorStatus,
} from './vendor.types';

type VendorRow = {
  id: string;
  clientId: string;
  vendorCode: string;
  vendorName: string;
  legalName: string | null;
  registrationNumber: string | null;
  taxNumber: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  vendorCategoryId: string | null;
  status: VendorStatus;
  createdAt: Date;
  updatedAt: Date;
};

const VENDOR_SELECT = `
  id,
  client_id AS "clientId",
  vendor_code AS "vendorCode",
  vendor_name AS "vendorName",
  legal_name AS "legalName",
  registration_number AS "registrationNumber",
  tax_number AS "taxNumber",
  email,
  phone,
  address,
  vendor_category_id AS "vendorCategoryId",
  status,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapVendorRow(row: VendorRow): VendorRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    vendorCode: row.vendorCode,
    vendorName: row.vendorName,
    legalName: row.legalName,
    registrationNumber: row.registrationNumber,
    taxNumber: row.taxNumber,
    email: row.email,
    phone: row.phone,
    address: row.address,
    vendorCategoryId: row.vendorCategoryId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createVendor(input: NewVendor): Promise<VendorRecord> {
  const result = await getPool().query<VendorRow>(
    `INSERT INTO vendors
       (id, client_id, vendor_code, vendor_name, legal_name,
        registration_number, tax_number, email, phone, address, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${VENDOR_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.vendorCode,
      input.vendorName,
      input.legalName,
      input.registrationNumber,
      input.taxNumber,
      input.email,
      input.phone,
      input.address,
      input.status,
    ],
  );

  return mapVendorRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorRecord | null> {
  const result = await getPool().query<VendorRow>(
    `SELECT ${VENDOR_SELECT} FROM vendors WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapVendorRow(row) : null;
}

async function findByCodeForClient(
  clientId: string,
  vendorCode: string,
): Promise<VendorRecord | null> {
  const result = await getPool().query<VendorRow>(
    `SELECT ${VENDOR_SELECT} FROM vendors
     WHERE client_id = $1 AND vendor_code = $2`,
    [clientId, vendorCode],
  );

  const row = result.rows[0];
  return row ? mapVendorRow(row) : null;
}

async function listByClient(clientId: string): Promise<VendorRecord[]> {
  const result = await getPool().query<VendorRow>(
    `SELECT ${VENDOR_SELECT} FROM vendors
     WHERE client_id = $1 ORDER BY vendor_code ASC`,
    [clientId],
  );

  return result.rows.map(mapVendorRow);
}

async function updateVendor(
  id: string,
  input: UpdateVendorInput,
): Promise<VendorRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.vendorName !== undefined) {
    values.push(input.vendorName);
    sets.push(`vendor_name = $${values.length}`);
  }
  if (input.legalName !== undefined) {
    values.push(input.legalName);
    sets.push(`legal_name = $${values.length}`);
  }
  if (input.registrationNumber !== undefined) {
    values.push(input.registrationNumber);
    sets.push(`registration_number = $${values.length}`);
  }
  if (input.taxNumber !== undefined) {
    values.push(input.taxNumber);
    sets.push(`tax_number = $${values.length}`);
  }
  if (input.email !== undefined) {
    values.push(input.email);
    sets.push(`email = $${values.length}`);
  }
  if (input.phone !== undefined) {
    values.push(input.phone);
    sets.push(`phone = $${values.length}`);
  }
  if (input.address !== undefined) {
    values.push(input.address);
    sets.push(`address = $${values.length}`);
  }
  if (input.vendorCategoryId !== undefined) {
    values.push(input.vendorCategoryId);
    sets.push(`vendor_category_id = $${values.length}`);
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

  const result = await getPool().query<VendorRow>(
    `UPDATE vendors SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${VENDOR_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapVendorRow(row) : null;
}

async function updateStatus(
  id: string,
  status: VendorStatus,
): Promise<VendorRecord | null> {
  const result = await getPool().query<VendorRow>(
    `UPDATE vendors SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${VENDOR_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapVendorRow(row) : null;
}

export const vendorRepository = {
  createVendor,
  findByCodeForClient,
  findById,
  listByClient,
  updateStatus,
  updateVendor,
};

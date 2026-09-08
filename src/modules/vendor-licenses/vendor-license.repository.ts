import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorLicense,
  UpdateVendorLicenseInput,
  VendorLicenseRecord,
  VendorLicenseRecordType,
  VendorLicenseStatus,
} from './vendor-license.types';

type VendorLicenseRow = {
  id: string;
  vendor_id: string;
  record_type: VendorLicenseRecordType;
  name: string;
  number: string;
  issuing_authority: string | null;
  issue_date: Date | null;
  expiry_date: Date | null;
  status: VendorLicenseStatus;
  document_reference: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
};

const LICENSE_SELECT = `
  id,
  vendor_id,
  record_type,
  name,
  number,
  issuing_authority,
  issue_date,
  expiry_date,
  status,
  document_reference,
  notes,
  created_at,
  updated_at
`;

function mapRow(row: VendorLicenseRow): VendorLicenseRecord {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    recordType: row.record_type,
    name: row.name,
    number: row.number,
    issuingAuthority: row.issuing_authority,
    issueDate: row.issue_date,
    expiryDate: row.expiry_date,
    status: row.status,
    documentReference: row.document_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(input: NewVendorLicense): Promise<VendorLicenseRecord> {
  const result = await getPool().query<VendorLicenseRow>(
    `INSERT INTO vendor_licenses_certifications
       (id, vendor_id, record_type, name, number, issuing_authority,
        issue_date, expiry_date, status, document_reference, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${LICENSE_SELECT}`,
    [
      randomUUID(),
      input.vendorId,
      input.recordType,
      input.name,
      input.number,
      input.issuingAuthority,
      input.issueDate,
      input.expiryDate,
      input.status,
      input.documentReference,
      input.notes,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorLicenseRecord | null> {
  const result = await getPool().query<VendorLicenseRow>(
    `SELECT ${LICENSE_SELECT} FROM vendor_licenses_certifications WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Every license/certification of one Vendor, history included. */
async function listByVendorId(
  vendorId: string,
): Promise<VendorLicenseRecord[]> {
  const result = await getPool().query<VendorLicenseRow>(
    `SELECT ${LICENSE_SELECT} FROM vendor_licenses_certifications
     WHERE vendor_id = $1
     ORDER BY record_type ASC, number ASC, created_at ASC`,
    [vendorId],
  );

  return result.rows.map(mapRow);
}

/**
 * The current/effective records of one Vendor at `asOf`: status ACTIVE and
 * expiry either absent or still in the future. Decided in SQL so every
 * caller gets the same answer.
 */
async function listCurrentByVendorId(
  vendorId: string,
  asOf: Date,
): Promise<VendorLicenseRecord[]> {
  const result = await getPool().query<VendorLicenseRow>(
    `SELECT ${LICENSE_SELECT} FROM vendor_licenses_certifications
     WHERE vendor_id = $1
       AND status = 'ACTIVE'
       AND (expiry_date IS NULL OR expiry_date >= $2)
     ORDER BY record_type ASC, number ASC, created_at ASC`,
    [vendorId, asOf],
  );

  return result.rows.map(mapRow);
}

async function findActiveByTypeAndNumber(
  vendorId: string,
  recordType: VendorLicenseRecordType,
  number: string,
): Promise<VendorLicenseRecord | null> {
  const result = await getPool().query<VendorLicenseRow>(
    `SELECT ${LICENSE_SELECT} FROM vendor_licenses_certifications
     WHERE vendor_id = $1
       AND record_type = $2
       AND number = $3
       AND status = 'ACTIVE'`,
    [vendorId, recordType, number],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function update(
  id: string,
  input: UpdateVendorLicenseInput,
): Promise<VendorLicenseRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    values.push(input.name);
    sets.push(`name = $${values.length}`);
  }
  if (input.number !== undefined) {
    values.push(input.number);
    sets.push(`number = $${values.length}`);
  }
  if (input.issuingAuthority !== undefined) {
    values.push(input.issuingAuthority);
    sets.push(`issuing_authority = $${values.length}`);
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
  if (input.documentReference !== undefined) {
    values.push(input.documentReference);
    sets.push(`document_reference = $${values.length}`);
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

  const result = await getPool().query<VendorLicenseRow>(
    `UPDATE vendor_licenses_certifications SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${LICENSE_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const vendorLicenseRepository = {
  create,
  findActiveByTypeAndNumber,
  findById,
  listByVendorId,
  listCurrentByVendorId,
  update,
};

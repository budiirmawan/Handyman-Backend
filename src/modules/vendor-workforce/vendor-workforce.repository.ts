import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  NewVendorWorkforceBinding,
  UpdateVendorWorkforceBindingInput,
  VendorWorkforceBindingRecord,
  VendorWorkforceBindingStatus,
} from './vendor-workforce.types';

type VendorWorkforceBindingRow = {
  id: string;
  vendor_id: string;
  workforce_profile_id: string;
  vendor_personnel_code: string;
  effective_from: Date | null;
  effective_until: Date | null;
  status: VendorWorkforceBindingStatus;
  created_at: Date;
  updated_at: Date;
};

const BINDING_SELECT = `
  id,
  vendor_id,
  workforce_profile_id,
  vendor_personnel_code,
  effective_from,
  effective_until,
  status,
  created_at,
  updated_at
`;

function mapRow(row: VendorWorkforceBindingRow): VendorWorkforceBindingRecord {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    workforceProfileId: row.workforce_profile_id,
    vendorPersonnelCode: row.vendor_personnel_code,
    effectiveFrom: row.effective_from,
    effectiveUntil: row.effective_until,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create(
  input: NewVendorWorkforceBinding,
): Promise<VendorWorkforceBindingRecord> {
  const result = await getPool().query<VendorWorkforceBindingRow>(
    `INSERT INTO vendor_workforce_bindings
       (id, vendor_id, workforce_profile_id, vendor_personnel_code,
        effective_from, effective_until, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${BINDING_SELECT}`,
    [
      randomUUID(),
      input.vendorId,
      input.workforceProfileId,
      input.vendorPersonnelCode,
      input.effectiveFrom,
      input.effectiveUntil,
      input.status,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
): Promise<VendorWorkforceBindingRecord | null> {
  const result = await getPool().query<VendorWorkforceBindingRow>(
    `SELECT ${BINDING_SELECT} FROM vendor_workforce_bindings WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Every workforce binding held by one Vendor, history included. */
async function listByVendorId(
  vendorId: string,
): Promise<VendorWorkforceBindingRecord[]> {
  const result = await getPool().query<VendorWorkforceBindingRow>(
    `SELECT ${BINDING_SELECT} FROM vendor_workforce_bindings
     WHERE vendor_id = $1
     ORDER BY created_at ASC`,
    [vendorId],
  );

  return result.rows.map(mapRow);
}

/** Every Vendor binding held by one Workforce Profile, history included. */
async function listByWorkforceProfileId(
  workforceProfileId: string,
): Promise<VendorWorkforceBindingRecord[]> {
  const result = await getPool().query<VendorWorkforceBindingRow>(
    `SELECT ${BINDING_SELECT} FROM vendor_workforce_bindings
     WHERE workforce_profile_id = $1
     ORDER BY created_at ASC`,
    [workforceProfileId],
  );

  return result.rows.map(mapRow);
}

/**
 * Resolves the binding addressed by the API route
 * (`/vendors/:vendorId/workforce/:workforceId`). Prefers the ACTIVE row so
 * an update targets the live binding rather than deactivated history.
 */
async function findByVendorAndWorkforce(
  vendorId: string,
  workforceProfileId: string,
): Promise<VendorWorkforceBindingRecord | null> {
  const result = await getPool().query<VendorWorkforceBindingRow>(
    `SELECT ${BINDING_SELECT} FROM vendor_workforce_bindings
     WHERE vendor_id = $1 AND workforce_profile_id = $2
     ORDER BY (status = 'ACTIVE') DESC, created_at DESC
     LIMIT 1`,
    [vendorId, workforceProfileId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findActiveByVendorAndWorkforce(
  vendorId: string,
  workforceProfileId: string,
): Promise<VendorWorkforceBindingRecord | null> {
  const result = await getPool().query<VendorWorkforceBindingRow>(
    `SELECT ${BINDING_SELECT} FROM vendor_workforce_bindings
     WHERE vendor_id = $1 AND workforce_profile_id = $2 AND status = 'ACTIVE'`,
    [vendorId, workforceProfileId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByVendorAndPersonnelCode(
  vendorId: string,
  vendorPersonnelCode: string,
): Promise<VendorWorkforceBindingRecord | null> {
  const result = await getPool().query<VendorWorkforceBindingRow>(
    `SELECT ${BINDING_SELECT} FROM vendor_workforce_bindings
     WHERE vendor_id = $1 AND vendor_personnel_code = $2`,
    [vendorId, vendorPersonnelCode],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function update(
  id: string,
  input: UpdateVendorWorkforceBindingInput,
): Promise<VendorWorkforceBindingRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.vendorPersonnelCode !== undefined) {
    values.push(input.vendorPersonnelCode);
    sets.push(`vendor_personnel_code = $${values.length}`);
  }
  if (input.effectiveFrom !== undefined) {
    values.push(input.effectiveFrom);
    sets.push(`effective_from = $${values.length}`);
  }
  if (input.effectiveUntil !== undefined) {
    values.push(input.effectiveUntil);
    sets.push(`effective_until = $${values.length}`);
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

  const result = await getPool().query<VendorWorkforceBindingRow>(
    `UPDATE vendor_workforce_bindings SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${BINDING_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const vendorWorkforceRepository = {
  create,
  findActiveByVendorAndWorkforce,
  findById,
  findByVendorAndPersonnelCode,
  findByVendorAndWorkforce,
  listByVendorId,
  listByWorkforceProfileId,
  update,
};

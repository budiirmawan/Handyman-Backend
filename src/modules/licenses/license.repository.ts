import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  LicenseRecord,
  LicenseStatus,
  NewLicense,
} from './license.types';

type LicenseRow = {
  id: string;
  subscriptionId: string;
  status: LicenseStatus;
  validFrom: Date;
  validUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const LICENSE_SELECT = `
  id,
  subscription_id AS "subscriptionId",
  status,
  valid_from AS "validFrom",
  valid_until AS "validUntil",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapLicenseRow(row: LicenseRow): LicenseRecord {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    status: row.status,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createLicense(input: NewLicense): Promise<LicenseRecord> {
  const result = await getPool().query<LicenseRow>(
    `INSERT INTO licenses
       (id, subscription_id, status, valid_from, valid_until)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${LICENSE_SELECT}`,
    [
      randomUUID(),
      input.subscriptionId,
      input.status,
      input.validFrom,
      input.validUntil,
    ],
  );

  return mapLicenseRow(result.rows[0]);
}

async function findById(id: string): Promise<LicenseRecord | null> {
  const result = await getPool().query<LicenseRow>(
    `SELECT ${LICENSE_SELECT} FROM licenses WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapLicenseRow(row) : null;
}

async function findBySubscriptionId(
  subscriptionId: string,
): Promise<LicenseRecord[]> {
  const result = await getPool().query<LicenseRow>(
    `SELECT ${LICENSE_SELECT} FROM licenses
     WHERE subscription_id = $1 ORDER BY valid_from DESC`,
    [subscriptionId],
  );

  return result.rows.map(mapLicenseRow);
}

async function findActiveBySubscriptionId(
  subscriptionId: string,
): Promise<LicenseRecord | null> {
  const result = await getPool().query<LicenseRow>(
    `SELECT ${LICENSE_SELECT} FROM licenses
     WHERE subscription_id = $1 AND status = 'ACTIVE'`,
    [subscriptionId],
  );

  const row = result.rows[0];
  return row ? mapLicenseRow(row) : null;
}

async function updateStatus(
  id: string,
  status: LicenseStatus,
): Promise<LicenseRecord | null> {
  const result = await getPool().query<LicenseRow>(
    `UPDATE licenses SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${LICENSE_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapLicenseRow(row) : null;
}

export const licenseRepository = {
  createLicense,
  findActiveBySubscriptionId,
  findBySubscriptionId,
  findById,
  updateStatus,
};

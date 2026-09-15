import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  AssetCertificationRecord,
  AssetCertificationStatus,
  NewAssetCertification,
  UpdateAssetCertificationInput,
} from './asset-certification.types';

type AssetCertificationRow = {
  id: string;
  assetId: string;
  certificationType: string;
  certificateNumber: string;
  issuingAuthority: string;
  issueDate: Date;
  expiryDate: Date | null;
  status: AssetCertificationStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const ASSET_CERTIFICATION_SELECT = `
  id,
  asset_id AS "assetId",
  certification_type AS "certificationType",
  certificate_number AS "certificateNumber",
  issuing_authority AS "issuingAuthority",
  issue_date AS "issueDate",
  expiry_date AS "expiryDate",
  status,
  notes,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: AssetCertificationRow): AssetCertificationRecord {
  return {
    id: row.id,
    assetId: row.assetId,
    certificationType: row.certificationType,
    certificateNumber: row.certificateNumber,
    issuingAuthority: row.issuingAuthority,
    issueDate: row.issueDate,
    expiryDate: row.expiryDate,
    status: row.status,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function createCertification(
  input: NewAssetCertification,
): Promise<AssetCertificationRecord> {
  const result = await getPool().query<AssetCertificationRow>(
    `INSERT INTO asset_certifications
       (id, asset_id, certification_type, certificate_number,
        issuing_authority, issue_date, expiry_date, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${ASSET_CERTIFICATION_SELECT}`,
    [
      randomUUID(),
      input.assetId,
      input.certificationType,
      input.certificateNumber,
      input.issuingAuthority,
      input.issueDate,
      input.expiryDate,
      input.status,
      input.notes,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(
  id: string,
): Promise<AssetCertificationRecord | null> {
  const result = await getPool().query<AssetCertificationRow>(
    `SELECT ${ASSET_CERTIFICATION_SELECT} FROM asset_certifications
     WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** The single ACTIVE certification of one type, when one exists. */
async function findActiveByType(
  assetId: string,
  certificationType: string,
): Promise<AssetCertificationRecord | null> {
  const result = await getPool().query<AssetCertificationRow>(
    `SELECT ${ASSET_CERTIFICATION_SELECT} FROM asset_certifications
     WHERE asset_id = $1 AND certification_type = $2 AND status = 'ACTIVE'`,
    [assetId, certificationType],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** All ACTIVE certifications of an Asset — one per type at most. */
async function listActiveByAssetId(
  assetId: string,
): Promise<AssetCertificationRecord[]> {
  const result = await getPool().query<AssetCertificationRow>(
    `SELECT ${ASSET_CERTIFICATION_SELECT} FROM asset_certifications
     WHERE asset_id = $1 AND status = 'ACTIVE'
     ORDER BY certification_type ASC`,
    [assetId],
  );

  return result.rows.map(mapRow);
}

async function findByNumberForAsset(
  assetId: string,
  certificateNumber: string,
): Promise<AssetCertificationRecord | null> {
  const result = await getPool().query<AssetCertificationRow>(
    `SELECT ${ASSET_CERTIFICATION_SELECT} FROM asset_certifications
     WHERE asset_id = $1 AND certificate_number = $2`,
    [assetId, certificateNumber],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Certification history of an Asset, newest issue first. */
async function listByAssetId(
  assetId: string,
  filters?: { status?: AssetCertificationStatus; certificationType?: string },
): Promise<AssetCertificationRecord[]> {
  const result = await getPool().query<AssetCertificationRow>(
    `SELECT ${ASSET_CERTIFICATION_SELECT} FROM asset_certifications
     WHERE asset_id = $1
       AND ($2::text IS NULL OR status = $2::text)
       AND ($3::text IS NULL OR certification_type = $3::text)
     ORDER BY issue_date DESC, created_at DESC`,
    [assetId, filters?.status ?? null, filters?.certificationType ?? null],
  );

  return result.rows.map(mapRow);
}

/**
 * Another certification of the same Asset AND same type whose validity
 * window overlaps [issueDate, expiryDate]. A NULL expiry is treated as open
 * ended, so a perpetual certification overlaps everything issued after it.
 */
async function findOverlapping(
  assetId: string,
  certificationType: string,
  issueDate: string,
  expiryDate: string | null,
  excludeId?: string,
): Promise<AssetCertificationRecord | null> {
  const result = await getPool().query<AssetCertificationRow>(
    `SELECT ${ASSET_CERTIFICATION_SELECT} FROM asset_certifications
     WHERE asset_id = $1
       AND certification_type = $2
       AND status <> 'INACTIVE'
       AND issue_date <= COALESCE($4::date, 'infinity'::date)
       AND COALESCE(expiry_date, 'infinity'::date) >= $3::date
       AND ($5::uuid IS NULL OR id <> $5::uuid)
     LIMIT 1`,
    [
      assetId,
      certificationType,
      issueDate,
      expiryDate,
      excludeId ?? null,
    ],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateCertification(
  id: string,
  input: UpdateAssetCertificationInput,
): Promise<AssetCertificationRecord | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  const assign = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (input.certificationType !== undefined) {
    assign('certification_type', input.certificationType);
  }
  if (input.certificateNumber !== undefined) {
    assign('certificate_number', input.certificateNumber);
  }
  if (input.issuingAuthority !== undefined) {
    assign('issuing_authority', input.issuingAuthority);
  }
  if (input.issueDate !== undefined) {
    assign('issue_date', input.issueDate);
  }
  if (input.expiryDate !== undefined) {
    assign('expiry_date', input.expiryDate);
  }
  if (input.status !== undefined) {
    assign('status', input.status);
  }
  if (input.notes !== undefined) {
    assign('notes', input.notes);
  }

  if (sets.length === 0) {
    return findById(id);
  }

  values.push(id);
  sets.push(`updated_at = NOW()`);

  const result = await getPool().query<AssetCertificationRow>(
    `UPDATE asset_certifications SET ${sets.join(', ')}
      WHERE id = $${values.length}
      RETURNING ${ASSET_CERTIFICATION_SELECT}`,
    values,
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function updateStatus(
  id: string,
  status: AssetCertificationStatus,
): Promise<AssetCertificationRecord | null> {
  const result = await getPool().query<AssetCertificationRow>(
    `UPDATE asset_certifications SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING ${ASSET_CERTIFICATION_SELECT}`,
    [id, status],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const assetCertificationRepository = {
  createCertification,
  findActiveByType,
  findById,
  findByNumberForAsset,
  findOverlapping,
  listActiveByAssetId,
  listByAssetId,
  updateCertification,
  updateStatus,
};

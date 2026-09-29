import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanQuotationRecord,
  HandymanQuotationVersionRecord,
  NewHandymanQuotation,
  NewHandymanQuotationVersion,
} from './handyman-quotation.types';

/**
 * CR-HM-06 PART 01 — Handyman quotation repository (FROZEN F1/F2).
 * Executor-first; INSERT + bounded reads + row lock ONLY. No UPDATE/
 * DELETE exists — the 0391 triggers already refuse them (immutable
 * identity/version facts; lifecycle projection arrives with PART 03).
 */

type QuotationRow = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

type VersionRow = {
  id: string;
  quotation_id: string;
  version_number: number;
  status: HandymanQuotationVersionRecord['status'];
  valid_until: Date | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
};

const QUOTATION_SELECT = `
  SELECT id, client_id, handyman_request_id, created_by_user_id,
         created_at, updated_at
    FROM handyman_quotations`;

const VERSION_SELECT = `
  SELECT id, quotation_id, version_number, status, valid_until,
         created_by_user_id, created_at, updated_at
    FROM handyman_quotation_versions`;

function mapQuotation(row: QuotationRow): HandymanQuotationRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: VersionRow): HandymanQuotationVersionRecord {
  return {
    id: row.id,
    quotationId: row.quotation_id,
    versionNumber: row.version_number,
    status: row.status,
    validUntil: row.valid_until,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertQuotation(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanQuotation,
): Promise<HandymanQuotationRecord> {
  const result = await executor.query<QuotationRow>(
    `INSERT INTO handyman_quotations (
       id, client_id, handyman_request_id, created_by_user_id
     ) VALUES ($1, $2, $3, $4)
     RETURNING id, client_id, handyman_request_id, created_by_user_id,
               created_at, updated_at`,
    [
      randomUUID(),
      input.clientId,
      input.handymanRequestId,
      input.createdByUserId,
    ],
  );
  return mapQuotation(result.rows[0]);
}

async function insertVersion(
  executor: Pick<PoolClient, 'query'>,
  input: NewHandymanQuotationVersion,
): Promise<HandymanQuotationVersionRecord> {
  const result = await executor.query<VersionRow>(
    `INSERT INTO handyman_quotation_versions (
       id, quotation_id, version_number, status, valid_until,
       created_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, quotation_id, version_number, status, valid_until,
               created_by_user_id, created_at, updated_at`,
    [
      randomUUID(),
      input.quotationId,
      input.versionNumber,
      input.status,
      input.validUntil,
      input.createdByUserId,
    ],
  );
  return mapVersion(result.rows[0]);
}

async function findQuotationById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanQuotationRecord | null> {
  const result = await executor.query<QuotationRow>(
    `${QUOTATION_SELECT} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapQuotation(result.rows[0]) : null;
}

async function findQuotationByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanQuotationRecord | null> {
  const result = await executor.query<QuotationRow>(
    `${QUOTATION_SELECT} WHERE handyman_request_id = $1`,
    [handymanRequestId],
  );
  return result.rows[0] ? mapQuotation(result.rows[0]) : null;
}

/** Row-level lock for atomic version allocation (F2/F9 allocation). */
async function lockQuotationById(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanQuotationRecord | null> {
  const result = await executor.query<QuotationRow>(
    `${QUOTATION_SELECT} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? mapQuotation(result.rows[0]) : null;
}

async function findVersionById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanQuotationVersionRecord | null> {
  const result = await executor.query<VersionRow>(
    `${VERSION_SELECT} WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? mapVersion(result.rows[0]) : null;
}

/**
 * PART 02 support — row-level lock on the exact version used by an
 * add-line transaction (serializes first-currency decision + ordering).
 */
async function lockVersionById(
  executor: Pick<PoolClient, 'query'>,
  id: string,
): Promise<HandymanQuotationVersionRecord | null> {
  const result = await executor.query<VersionRow>(
    `${VERSION_SELECT} WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? mapVersion(result.rows[0]) : null;
}

/** PART 03 — the single current ISSUED version of a thread (locked). */
async function findCurrentIssued(
  executor: Pick<PoolClient, 'query'> = getPool(),
  quotationId: string,
): Promise<HandymanQuotationVersionRecord | null> {
  const result = await executor.query<VersionRow>(
    `${VERSION_SELECT} WHERE quotation_id = $1 AND status = 'ISSUED'
     ORDER BY version_number DESC
     LIMIT 1
     FOR UPDATE`,
    [quotationId],
  );
  return result.rows[0] ? mapVersion(result.rows[0]) : null;
}

/**
 * PART 03 — bounded LIFECYCLE PROJECTION ONLY: status (+ validUntil for
 * new issuance). The 0391 trigger refuses any other column change, so
 * identity/version/commercial facts can never be rewritten here.
 */
async function updateVersionLifecycle(
  executor: Pick<PoolClient, 'query'>,
  id: string,
  status: HandymanQuotationVersionRecord['status'],
  validUntil: Date | null | undefined,
): Promise<HandymanQuotationVersionRecord | null> {
  const result = await executor.query<VersionRow>(
    `UPDATE handyman_quotation_versions
        SET status = $2,
            valid_until = COALESCE($3, valid_until),
            updated_at = NOW()
      WHERE id = $1
      RETURNING id, quotation_id, version_number, status, valid_until,
                created_by_user_id, created_at, updated_at`,
    [id, status, validUntil ?? null],
  );
  return result.rows[0] ? mapVersion(result.rows[0]) : null;
}

async function listVersions(
  executor: Pick<PoolClient, 'query'> = getPool(),
  quotationId: string,
): Promise<HandymanQuotationVersionRecord[]> {
  const result = await executor.query<VersionRow>(
    `${VERSION_SELECT} WHERE quotation_id = $1
     ORDER BY version_number ASC`,
    [quotationId],
  );
  return result.rows.map(mapVersion);
}

/** Highest allocated version number under the caller's root lock. */
async function maxVersionNumber(
  executor: Pick<PoolClient, 'query'>,
  quotationId: string,
): Promise<number> {
  const result = await executor.query<{ max: number | null }>(
    `SELECT MAX(version_number)::int AS max
       FROM handyman_quotation_versions
      WHERE quotation_id = $1`,
    [quotationId],
  );
  return result.rows[0]?.max ?? 0;
}

export const handymanQuotationRepository = {
  insertQuotation,
  insertVersion,
  findVersionById,
  lockVersionById,
  findCurrentIssued,
  updateVersionLifecycle,
  findQuotationById,
  findQuotationByRequest,
  lockQuotationById,
  listVersions,
  maxVersionNumber,
};

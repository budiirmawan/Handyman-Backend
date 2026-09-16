import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanQuotationRevisionRecord,
} from './handyman-quotation.types';

/**
 * CR-HM-BE-03 RUN 2 — Quotation revision persistence.
 *
 * DRAFT → SUBMITTED → SUPERSEDED with server-authoritative sequential
 * revision numbers; SUBMITTED facts are immutable (no UPDATE ever rewrites
 * submitted content); at most one DRAFT per quotation (partial unique index
 * in migration 0351).
 */

const REVISION_SELECT = `
  id,
  quotation_id AS "quotationId",
  client_id AS "clientId",
  building_id AS "buildingId",
  revision_number AS "revisionNumber",
  status,
  notes,
  valid_until AS "validUntil",
  submitted_at AS "submittedAt",
  submitted_by_user_id AS "submittedByUserId",
  superseded_at AS "supersededAt",
  superseded_by_user_id AS "supersededByUserId",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

async function create(
  input: {
    quotationId: string;
    clientId: string;
    buildingId: string;
    revisionNumber: number;
    notes: string | null;
    validUntil: string | null;
    createdByUserId: string;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationRevisionRecord> {
  const result = await executor.query<HandymanQuotationRevisionRecord>(
    `INSERT INTO handyman_quotation_revisions
       (id, quotation_id, client_id, building_id, revision_number, notes,
        valid_until, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${REVISION_SELECT}`,
    [
      randomUUID(),
      input.quotationId,
      input.clientId,
      input.buildingId,
      input.revisionNumber,
      input.notes,
      input.validUntil,
      input.createdByUserId,
    ],
  );
  return result.rows[0];
}

async function findById(
  id: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationRevisionRecord | null> {
  const result = await executor.query<HandymanQuotationRevisionRecord>(
    `SELECT ${REVISION_SELECT} FROM handyman_quotation_revisions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Row lock used to sequence revision numbers and line numbers. */
async function lockById(
  id: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationRevisionRecord | null> {
  const result = await executor.query<HandymanQuotationRevisionRecord>(
    `SELECT ${REVISION_SELECT} FROM handyman_quotation_revisions
     WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function listByQuotation(
  quotationId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationRevisionRecord[]> {
  const result = await executor.query<HandymanQuotationRevisionRecord>(
    `SELECT ${REVISION_SELECT} FROM handyman_quotation_revisions
     WHERE quotation_id = $1
     ORDER BY revision_number DESC`,
    [quotationId],
  );
  return result.rows;
}

async function findDraftByQuotation(
  quotationId: string,
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<HandymanQuotationRevisionRecord | null> {
  const result = await executor.query<HandymanQuotationRevisionRecord>(
    `SELECT ${REVISION_SELECT} FROM handyman_quotation_revisions
     WHERE quotation_id = $1 AND status = 'DRAFT'`,
    [quotationId],
  );
  return result.rows[0] ?? null;
}

async function findMaxRevisionNumber(
  quotationId: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<number> {
  const result = await executor.query<{ max: string | null }>(
    `SELECT MAX(revision_number)::TEXT AS max
     FROM handyman_quotation_revisions
     WHERE quotation_id = $1`,
    [quotationId],
  );
  return result.rows[0]?.max ? Number(result.rows[0].max) : 0;
}

/** Guarded DRAFT → SUBMITTED; returns null when a concurrent command won. */
async function submitFromDraft(
  id: string,
  actorUserId: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<HandymanQuotationRevisionRecord | null> {
  const result = await executor.query<HandymanQuotationRevisionRecord>(
    `UPDATE handyman_quotation_revisions
     SET status = 'SUBMITTED',
         submitted_at = NOW(),
         submitted_by_user_id = $2,
         updated_at = NOW()
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${REVISION_SELECT}`,
    [id, actorUserId],
  );
  return result.rows[0] ?? null;
}

/**
 * Guarded SUBMITTED → SUPERSEDED for every prior submitted revision of the
 * quotation except the newly submitted one. Run 2 note: the quotation
 * envelope has no approval binding yet, so no revision here can be an
 * approved-bound revision; later runs must additionally exclude the revision
 * bound by an approval before superseding.
 */
async function supersedeSubmittedExcept(
  quotationId: string,
  exceptRevisionId: string,
  actorUserId: string,
  executor: Pick<PoolClient, 'query'>,
): Promise<string[]> {
  const result = await executor.query<{ id: string }>(
    `UPDATE handyman_quotation_revisions
     SET status = 'SUPERSEDED',
         superseded_at = NOW(),
         superseded_by_user_id = $3,
         updated_at = NOW()
     WHERE quotation_id = $1 AND status = 'SUBMITTED' AND id <> $2
     RETURNING id`,
    [quotationId, exceptRevisionId, actorUserId],
  );
  return result.rows.map((row) => row.id);
}

export const handymanQuotationRevisionRepository = {
  create,
  findById,
  lockById,
  listByQuotation,
  findDraftByQuotation,
  findMaxRevisionNumber,
  submitFromDraft,
  supersedeSubmittedExcept,
};

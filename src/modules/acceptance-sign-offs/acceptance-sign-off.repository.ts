import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type { AcceptanceSignOffFilters, AcceptanceSignOffRecord } from './acceptance-sign-off.types';

const SELECT = `
  aso.id,
  aso.bast_document_id AS "bastDocumentId",
  aso.handover_document_id AS "handoverDocumentId",
  aso.bast_submission_attempt_id AS "bastSubmissionAttemptId",
  aso.document_version_id AS "documentVersionId",
  aso.client_id AS "clientId",
  aso.building_id AS "buildingId",
  aso.context_type AS "contextType",
  aso.decision,
  aso.signer_user_id AS "signerUserId",
  aso.notes,
  aso.signed_at AS "signedAt",
  aso.created_at AS "createdAt",
  aso.updated_at AS "updatedAt"
`;

// INSERT ... RETURNING cannot reference the table alias; use unaliased columns.
const RETURNING = `
  id,
  bast_document_id AS "bastDocumentId",
  handover_document_id AS "handoverDocumentId",
  bast_submission_attempt_id AS "bastSubmissionAttemptId",
  document_version_id AS "documentVersionId",
  client_id AS "clientId",
  building_id AS "buildingId",
  context_type AS "contextType",
  decision,
  signer_user_id AS "signerUserId",
  notes,
  signed_at AS "signedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export async function create(
  input: {
    bastDocumentId: string | null;
    handoverDocumentId: string | null;
    clientId: string;
    buildingId: string;
    contextType: string;
    decision: string;
    signerUserId: string;
    notes: string | null;
    bastSubmissionAttemptId?: string | null;
    documentVersionId?: string | null;
  },
  executor: Pick<PoolClient, 'query'> = getPool(),
): Promise<AcceptanceSignOffRecord> {
  const result = await executor.query<AcceptanceSignOffRecord>(
    `INSERT INTO acceptance_sign_offs
       (id, bast_document_id, handover_document_id,
        bast_submission_attempt_id, document_version_id,
        client_id, building_id, context_type, decision, signer_user_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING ${RETURNING}`,
    [
      randomUUID(),
      input.bastDocumentId,
      input.handoverDocumentId,
      input.bastSubmissionAttemptId ?? null,
      input.documentVersionId ?? null,
      input.clientId,
      input.buildingId,
      input.contextType,
      input.decision,
      input.signerUserId,
      input.notes,
    ],
  );
  return result.rows[0];
}

export async function findById(id: string): Promise<AcceptanceSignOffRecord | null> {
  const result = await getPool().query<AcceptanceSignOffRecord>(`SELECT ${SELECT} FROM acceptance_sign_offs aso WHERE aso.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function list(
  filters: AcceptanceSignOffFilters,
  accessibleBuildingIds: string[],
  accessibleClientIds: string[],
): Promise<AcceptanceSignOffRecord[]> {
  if (accessibleBuildingIds.length === 0 && accessibleClientIds.length === 0) return [];
  const values: unknown[] = [];
  const clauses: string[] = [];

  values.push(accessibleBuildingIds);
  const buildingListParam = `$${values.length}`;
  values.push(accessibleClientIds);
  const clientListParam = `$${values.length}`;
  clauses.push(`(
    (aso.building_id = ANY(${buildingListParam}::uuid[]))
    OR (aso.building_id IS NULL AND aso.client_id = ANY(${clientListParam}::uuid[]))
  )`);

  if (filters.clientId) { values.push(filters.clientId); clauses.push(`aso.client_id = $${values.length}`); }
  if (filters.buildingId) { values.push(filters.buildingId); clauses.push(`aso.building_id = $${values.length}`); }
  if (filters.bastDocumentId) { values.push(filters.bastDocumentId); clauses.push(`aso.bast_document_id = $${values.length}`); }
  if (filters.handoverDocumentId) { values.push(filters.handoverDocumentId); clauses.push(`aso.handover_document_id = $${values.length}`); }
  if (filters.contextType) { values.push(filters.contextType); clauses.push(`aso.context_type = $${values.length}`); }
  if (filters.decision) { values.push(filters.decision); clauses.push(`aso.decision = $${values.length}`); }
  if (filters.signerUserId) { values.push(filters.signerUserId); clauses.push(`aso.signer_user_id = $${values.length}`); }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await getPool().query<AcceptanceSignOffRecord>(`SELECT ${SELECT} FROM acceptance_sign_offs aso ${where} ORDER BY aso.signed_at DESC, aso.created_at DESC`, values);
  return result.rows;
}

export const acceptanceSignOffRepository = {
  create,
  findById,
  list,
};

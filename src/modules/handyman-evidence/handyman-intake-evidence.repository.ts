import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanIntakeEvidenceRecord,
} from './handyman-intake-evidence.types';
import { HANDYMAN_REQUEST_EVIDENCE_PARENT } from './handyman-intake-evidence.types';

/**
 * CR-HM-02 PART 04 — Handyman intake evidence persistence, THROUGH the
 * shared evidence engine (`evidence_submissions`): same table, same safe
 * file-metadata conventions, same hash-consistency CHECK, same retention
 * columns (engine defaults apply — no Handyman-side variation).
 *
 * `file_size` is BIGINT and read via ::float8 (bounded by the shared 50 MB
 * CHECK, so it always fits a JS number).
 */

const EVIDENCE_SELECT = `
  id,
  client_id AS "clientId",
  execution_id AS "handymanRequestId",
  evidence_type AS "evidenceKind",
  original_file_name AS "originalFileName",
  mime_type AS "mimeType",
  file_size::float8 AS "fileSize",
  captured_at AS "capturedAt",
  submitted_by_user_id AS "submittedByUserId",
  content_sha256 AS "contentSha256",
  status,
  created_at AS "createdAt"
`;

const PARENT_WHERE = `execution_type = '${HANDYMAN_REQUEST_EVIDENCE_PARENT}'`;

async function insertEvidence(
  executor: Pick<PoolClient, 'query'> = getPool(),
  evidence: {
    id: string;
    clientId: string;
    handymanRequestId: string;
    evidenceKind: 'PHOTO' | 'VIDEO';
    fileReference: string;
    originalFileName: string;
    mimeType: string;
    fileSize: number;
    submittedByUserId: string | null;
    contentSha256: string;
  },
): Promise<HandymanIntakeEvidenceRecord> {
  const result = await executor.query<HandymanIntakeEvidenceRecord>(
    `INSERT INTO evidence_submissions
       (id, client_id, evidence_requirement_id, execution_type,
        execution_id, evidence_type, file_reference, original_file_name,
        mime_type, file_size, captured_at, submitted_by_user_id,
        content_sha256, content_hashed_at, hash_algorithm)
     VALUES ($1, $2, NULL, '${HANDYMAN_REQUEST_EVIDENCE_PARENT}', $3, $4,
             $5, $6, $7, $8, NOW(), $9, $10, NOW(), 'SHA-256')
     RETURNING ${EVIDENCE_SELECT}`,
    [
      evidence.id,
      evidence.clientId,
      evidence.handymanRequestId,
      evidence.evidenceKind,
      evidence.fileReference,
      evidence.originalFileName,
      evidence.mimeType,
      evidence.fileSize,
      evidence.submittedByUserId,
      evidence.contentSha256,
    ],
  );
  return result.rows[0];
}

async function findById(
  executor: Pick<PoolClient, 'query'> = getPool(),
  id: string,
): Promise<HandymanIntakeEvidenceRecord | null> {
  const result = await executor.query<HandymanIntakeEvidenceRecord>(
    `SELECT ${EVIDENCE_SELECT} FROM evidence_submissions
      WHERE ${PARENT_WHERE} AND id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** All intake evidence for one Handyman request (execution-scoped). */
async function listForRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanIntakeEvidenceRecord[]> {
  const result = await executor.query<HandymanIntakeEvidenceRecord>(
    `SELECT ${EVIDENCE_SELECT} FROM evidence_submissions
      WHERE ${PARENT_WHERE} AND execution_id = $1
      ORDER BY created_at ASC, id ASC`,
    [handymanRequestId],
  );
  return result.rows;
}

export const handymanIntakeEvidenceRepository = {
  insertEvidence,
  findById,
  listForRequest,
};

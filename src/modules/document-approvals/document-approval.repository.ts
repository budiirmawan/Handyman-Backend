import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type { DocumentApprovalRecord } from './document-approval.types';

const SELECT = `
  r.id,
  r.target_id AS "documentId",
  CASE WHEN r.target_type = 'DOCUMENT_VERSION' THEN r.target_id ELSE NULL END AS "versionId",
  r.client_id AS "clientId",
  COALESCE(d.building_id, dv.building_id) AS "buildingId",
  COALESCE(d.context_type, 'INTERNAL') AS "contextType",
  r.status,
  r.decision,
  r.reviewer_user_id AS "reviewerUserId",
  r.notes,
  r.reviewed_at AS "reviewedAt",
  r.created_at AS "createdAt",
  r.updated_at AS "updatedAt",
  d.id AS "docExists"
`;

// Simpler: store approvals directly in reviews with client_id from document
// We need to handle both DOCUMENT and DOCUMENT_VERSION targets

export async function create(input: {
  documentId: string;
  versionId: string | null;
  clientId: string;
  buildingId: string | null;
  reviewerUserId: string;
  notes: string | null;
  createdByUserId: string;
}): Promise<DocumentApprovalRecord> {
  const reviewId = randomUUID();
  const targetType = input.versionId ? 'DOCUMENT_VERSION' : 'DOCUMENT';
  const targetId = input.versionId ?? input.documentId;

  await getPool().query(
    `INSERT INTO reviews (id, client_id, target_type, target_id, reviewer_user_id, status, notes)
     VALUES ($1,$2,$3,$4,$5,'PENDING',$6)`,
    [reviewId, input.clientId, targetType, targetId, input.reviewerUserId, input.notes],
  );

  // For simplicity, we store building/context via join to documents, but we need to fetch
  const doc = await getPool().query(`SELECT building_id, context_type FROM documents WHERE id = $1`, [input.documentId]);
  const buildingId = doc.rows[0]?.building_id ?? input.buildingId;
  const contextType = doc.rows[0]?.context_type ?? 'INTERNAL';

  return {
    id: reviewId,
    documentId: input.documentId,
    versionId: input.versionId,
    clientId: input.clientId,
    buildingId,
    contextType,
    status: 'PENDING',
    decision: null,
    reviewerUserId: input.reviewerUserId,
    notes: input.notes,
    reviewedAt: null,
    createdByUserId: input.createdByUserId,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as DocumentApprovalRecord;
}

export async function findById(id: string): Promise<DocumentApprovalRecord | null> {
  const result = await getPool().query(
    `SELECT r.id, r.target_id AS "documentId", r.client_id AS "clientId", r.status, r.decision, r.reviewer_user_id AS "reviewerUserId", r.notes, r.reviewed_at AS "reviewedAt", r.created_at AS "createdAt", r.updated_at AS "updatedAt",
            d.building_id AS "buildingId", d.context_type AS "contextType", r.target_type
     FROM reviews r
     LEFT JOIN documents d ON d.id = r.target_id AND r.target_type = 'DOCUMENT'
     LEFT JOIN document_versions dv ON dv.id = r.target_id AND r.target_type = 'DOCUMENT_VERSION'
     LEFT JOIN documents d2 ON d2.id = dv.document_id
     WHERE r.id = $1`,
    [id],
  );
  if (!result.rowCount) return null;
  const row = result.rows[0] as any;
  // Normalize documentId/versionId
  const isVersion = row.target_type === 'DOCUMENT_VERSION';
  // For version, we need to fetch version's documentId
  let documentId = row.documentId;
  let versionId: string | null = null;
  let buildingId = row.buildingId;
  let contextType = row.contextType;
  let clientId = row.clientId;
  if (isVersion) {
    versionId = row.documentId; // target_id is versionId in this case
    // Need to resolve documentId from version
    const v = await getPool().query(`SELECT document_id, building_id FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = $1`, [versionId]);
    if (v.rowCount) {
      documentId = v.rows[0].document_id;
      buildingId = v.rows[0].building_id;
      // context from document
      const d2 = await getPool().query(`SELECT context_type, client_id FROM documents WHERE id = $1`, [documentId]);
      if (d2.rowCount) {
        contextType = d2.rows[0].context_type;
        clientId = d2.rows[0].client_id;
      }
    }
  } else {
    // document case, versionId null
    versionId = null;
  }

  return {
    id: row.id,
    documentId,
    versionId,
    clientId,
    buildingId,
    contextType: contextType ?? 'INTERNAL',
    status: row.status,
    decision: row.decision,
    reviewerUserId: row.reviewerUserId,
    notes: row.notes,
    reviewedAt: row.reviewedAt,
    createdByUserId: null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listByDocument(documentId: string): Promise<DocumentApprovalRecord[]> {
  const result = await getPool().query(
    `SELECT r.id, r.target_type, r.target_id, r.client_id AS "clientId", r.status, r.decision, r.reviewer_user_id AS "reviewerUserId", r.notes, r.reviewed_at AS "reviewedAt", r.created_at AS "createdAt", r.updated_at AS "updatedAt"
     FROM reviews r
     WHERE (r.target_type = 'DOCUMENT' AND r.target_id = $1)
        OR (r.target_type = 'DOCUMENT_VERSION' AND r.target_id IN (SELECT id FROM document_versions WHERE document_id = $1))
     ORDER BY r.created_at ASC`,
    [documentId],
  );
  const records: DocumentApprovalRecord[] = [];
  for (const row of result.rows as any[]) {
    const isVersion = row.target_type === 'DOCUMENT_VERSION';
    let docId = documentId;
    let versionId: string | null = null;
    let buildingId: string | null = null;
    let contextType = 'INTERNAL';
    let clientId = row.clientId;
    if (isVersion) {
      versionId = row.target_id;
      const v = await getPool().query(`SELECT document_id FROM document_versions WHERE id = $1`, [versionId]);
      if (v.rowCount) docId = v.rows[0].document_id;
    }
    // Fetch building/context
    const d = await getPool().query(`SELECT building_id, context_type, client_id FROM documents WHERE id = $1`, [docId]);
    if (d.rowCount) {
      buildingId = d.rows[0].building_id;
      contextType = d.rows[0].context_type;
      clientId = d.rows[0].client_id;
    }
    records.push({
      id: row.id,
      documentId: docId,
      versionId,
      clientId,
      buildingId,
      contextType,
      status: row.status,
      decision: row.decision,
      reviewerUserId: row.reviewerUserId,
      notes: row.notes,
      reviewedAt: row.reviewedAt,
      createdByUserId: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
  return records;
}

export async function findPendingByTargetAndReviewer(
  documentId: string,
  versionId: string | null,
  reviewerUserId: string,
): Promise<DocumentApprovalRecord | null> {
  const targetType = versionId ? 'DOCUMENT_VERSION' : 'DOCUMENT';
  const targetId = versionId ?? documentId;
  const result = await getPool().query(
    `SELECT r.id FROM reviews r
     WHERE r.target_type = $1 AND r.target_id = $2
       AND r.reviewer_user_id = $3 AND r.status = 'PENDING'`,
    [targetType, targetId, reviewerUserId],
  );
  if (!result.rowCount) return null;
  return findById(result.rows[0].id);
}

export async function completeReview(reviewId: string, decision: 'APPROVED' | 'REJECTED', notes: string | null): Promise<boolean> {
  const result = await getPool().query(
    `UPDATE reviews SET decision = $2, notes = COALESCE($3, notes), status = 'COMPLETED', reviewed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'PENDING'`,
    [reviewId, decision, notes],
  );
  return (result.rowCount ?? 0) > 0;
}

export const documentApprovalRepository = {
  completeReview,
  create,
  findById,
  findPendingByTargetAndReviewer,
  listByDocument,
};

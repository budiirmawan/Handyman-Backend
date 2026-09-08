import { getPool } from '../../database';

/** Document approvals have no cross-document pending-list repository. */
export type PendingDocumentApprovalRow = {
  approvalId: string;
  clientId: string;
  buildingId: string | null;
  approvalType: string;
  resourceType: string;
  resourceId: string;
  resourceReference: string;
  submittedAt: Date;
};

/**
 * Reads only the existing BE-22I review rows. Building-bound Documents use the
 * selected Building set. Client-level Documents are admitted only for an
 * ALL_ACCESSIBLE/CLIENT scope, matching the existing Document access model.
 */
export async function listPendingDocumentApprovals(
  buildingIds: string[],
  clientIds: string[],
  includeClientLevel: boolean,
  start: Date | null,
  end: Date | null,
): Promise<PendingDocumentApprovalRow[]> {
  if (buildingIds.length === 0 && clientIds.length === 0) return [];

  const result = await getPool().query<PendingDocumentApprovalRow>(
    `SELECT
       r.id AS "approvalId",
       d.client_id AS "clientId",
       d.building_id AS "buildingId",
       CASE
         WHEN r.target_type = 'DOCUMENT_VERSION'
           THEN 'DOCUMENT_VERSION_APPROVAL'
         ELSE 'DOCUMENT_APPROVAL'
       END AS "approvalType",
       r.target_type AS "resourceType",
       r.target_id AS "resourceId",
       d.document_number AS "resourceReference",
       r.created_at AS "submittedAt"
     FROM reviews r
     LEFT JOIN document_versions dv
       ON r.target_type = 'DOCUMENT_VERSION' AND dv.id = r.target_id
     JOIN documents d
       ON d.id = CASE
         WHEN r.target_type = 'DOCUMENT' THEN r.target_id
         ELSE dv.document_id
       END
     WHERE r.target_type IN ('DOCUMENT', 'DOCUMENT_VERSION')
       AND r.status = 'PENDING'
       AND (
         d.building_id = ANY($1::uuid[])
         OR ($3::boolean AND d.building_id IS NULL
             AND d.client_id = ANY($2::uuid[]))
       )
       AND ($4::timestamptz IS NULL OR r.created_at >= $4)
       AND ($5::timestamptz IS NULL OR r.created_at < $5)
     ORDER BY r.created_at ASC, r.id ASC`,
    [buildingIds, clientIds, includeClientLevel, start, end],
  );
  return result.rows;
}

export const managementPendingApprovalRepository = {
  listPendingDocumentApprovals,
};

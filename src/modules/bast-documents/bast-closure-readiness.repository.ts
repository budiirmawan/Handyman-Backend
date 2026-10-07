import { getPool } from '../../database';

export type BastClosureVendorWorkRecord = {
  id: string;
  contextMatches: boolean;
  hasUnresolvedRework: boolean;
};

export type BastClosureDocumentRecord = {
  id: string;
  vendorWorkId: string | null;
  acceptanceScopeType: string | null;
  acceptanceStatus: string;
  contextMatches: boolean;
  acceptanceTraceable: boolean;
  hasOpenReconciliationQuarantine: boolean;
  hasUnresolvedFinding: boolean;
};

async function listVendorWorks(input: {
  workOrderId: string;
  clientId: string;
  buildingId: string;
}): Promise<BastClosureVendorWorkRecord[]> {
  const result = await getPool().query<BastClosureVendorWorkRecord>(
    `SELECT
       vw.id,
       (
         vw.work_order_id = $1
         AND vw.building_id = $3
         AND va.id = vw.vendor_assignment_id
         AND va.vendor_id = vw.vendor_id
         AND va.work_order_id = vw.work_order_id
         AND va.building_id = vw.building_id
         AND v.id = vw.vendor_id
         AND v.client_id = $2
       ) AS "contextMatches",
       EXISTS (
         SELECT 1
         FROM vendor_rework_cycles vrc
         WHERE vrc.vendor_work_id = vw.id
           AND vrc.status = 'REQUESTED'
       ) AS "hasUnresolvedRework"
     FROM vendor_works vw
     LEFT JOIN vendor_assignments va ON va.id = vw.vendor_assignment_id
     LEFT JOIN vendors v ON v.id = vw.vendor_id
     WHERE vw.work_order_id = $1
     ORDER BY vw.id`,
    [input.workOrderId, input.clientId, input.buildingId],
  );
  return result.rows;
}

async function listCanonicalBastDocuments(input: {
  workOrderId: string;
  clientId: string;
  buildingId: string;
}): Promise<BastClosureDocumentRecord[]> {
  const result = await getPool().query<BastClosureDocumentRecord>(
    `SELECT
       bd.id,
       bd.vendor_work_id AS "vendorWorkId",
       bd.acceptance_scope_type AS "acceptanceScopeType",
       bd.acceptance_status AS "acceptanceStatus",
       (
         bd.client_id = $2
         AND bd.building_id = $3
         AND d.client_id = bd.client_id
         AND d.building_id = bd.building_id
         AND d.context_type = bd.context_type
         AND d.document_type = 'BAST'
         AND (
           (
             bd.acceptance_scope_type = 'WORK_ORDER'
             AND bd.vendor_work_id IS NULL
           )
           OR
           (
             bd.acceptance_scope_type = 'VENDOR_WORK'
             AND bd.vendor_work_id IS NOT NULL
             AND vw.id = bd.vendor_work_id
             AND vw.work_order_id = bd.work_order_id
             AND vw.building_id = bd.building_id
             AND vw.vendor_id = bd.vendor_id
             AND v.id = vw.vendor_id
             AND v.client_id = bd.client_id
           )
         )
       ) AS "contextMatches",
       EXISTS (
         SELECT 1
         FROM bast_submission_attempts bsa
         JOIN document_versions dv
           ON dv.id = bsa.document_version_id
          AND dv.document_id = bd.document_id
         JOIN acceptance_sign_offs aso
           ON aso.bast_submission_attempt_id = bsa.id
          AND aso.bast_document_id = bd.id
          AND aso.document_version_id = bsa.document_version_id
          AND aso.client_id = bd.client_id
          AND aso.building_id = bd.building_id
          AND aso.context_type = bd.context_type
          AND aso.decision = 'ACCEPTED'
          AND aso.signer_user_id = bd.accepted_by_user_id
         WHERE bsa.bast_document_id = bd.id
           AND bsa.submitted_by_user_id = bd.submitted_by_user_id
           AND bd.submitted_at IS NOT NULL
           AND bd.accepted_at IS NOT NULL
           AND bd.accepted_at >= bd.submitted_at
           AND aso.signed_at >= bsa.submitted_at
           AND aso.signed_at >= bd.submitted_at
           AND bsa.attempt_number = (
             SELECT MAX(current_attempt.attempt_number)
             FROM bast_submission_attempts current_attempt
             WHERE current_attempt.bast_document_id = bd.id
           )
       ) AS "acceptanceTraceable",
       EXISTS (
         SELECT 1
         FROM bast_reconciliation_quarantines brq
         WHERE brq.bast_document_id = bd.id
           AND brq.status = 'OPEN'
       ) AS "hasOpenReconciliationQuarantine",
       EXISTS (
         SELECT 1
         FROM bast_finding_links bfl
         JOIN findings f ON f.id = bfl.finding_id
         WHERE bfl.bast_document_id = bd.id
           AND f.status NOT IN ('CLOSED', 'CANCELLED')
       ) AS "hasUnresolvedFinding"
     FROM bast_documents bd
     LEFT JOIN documents d ON d.id = bd.document_id
     LEFT JOIN vendor_works vw ON vw.id = bd.vendor_work_id
     LEFT JOIN vendors v ON v.id = vw.vendor_id
     WHERE bd.work_order_id = $1
     ORDER BY bd.id`,
    [input.workOrderId, input.clientId, input.buildingId],
  );
  return result.rows;
}

export const bastClosureReadinessRepository = {
  listCanonicalBastDocuments,
  listVendorWorks,
};

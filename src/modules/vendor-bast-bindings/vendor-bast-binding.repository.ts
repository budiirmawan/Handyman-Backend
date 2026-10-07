import { getPool } from '../../database';
import type {
  BastStatus,
  VendorBastAcceptanceSignOffRecord,
  VendorBastRecord,
} from './vendor-bast-binding.types';

/**
 * CR-BE-BAST-01 PART 03 — read-only legacy compatibility repository.
 *
 * Lifecycle columns from `vendor_bast_bindings` are retained only as
 * historical inputs to reconciliation. A context-consistent canonical link
 * projects lifecycle actors, timestamps, status, and the current immutable
 * acceptance Sign-Off from BE-22.
 */
type VendorBastRow = {
  id: string;
  rawBastDocumentId: string | null;
  clientId: string;
  vendorWorkId: string;
  completionReportId: string | null;
  serviceReportId: string | null;
  workOrderId: string;
  buildingId: string;
  bastNumber: string;
  bastDate: string | Date;
  preparedByUserId: string;
  legacySubmittedByUserId: string | null;
  legacyAcceptedByUserId: string | null;
  legacyAcceptanceStatus: BastStatus;
  notes: string | null;
  fileReference: string | null;
  legacySubmittedAt: Date | null;
  legacyAcceptedAt: Date | null;
  createdAt: Date;
  legacyUpdatedAt: Date;
  canonicalBastDocumentId: string | null;
  canonicalClientId: string | null;
  canonicalBuildingId: string | null;
  canonicalWorkOrderId: string | null;
  canonicalVendorWorkId: string | null;
  canonicalCompletionReportId: string | null;
  canonicalServiceReportId: string | null;
  canonicalBastNumber: string | null;
  canonicalAcceptanceStatus: BastStatus | null;
  canonicalSubmittedByUserId: string | null;
  canonicalAcceptedByUserId: string | null;
  canonicalSubmittedAt: Date | null;
  canonicalAcceptedAt: Date | null;
  canonicalUpdatedAt: Date | null;
  signOffId: string | null;
  signOffAttemptId: string | null;
  signOffDocumentVersionId: string | null;
  signOffDecision: 'ACCEPTED' | 'REJECTED' | null;
  signOffSignerUserId: string | null;
  signOffNotes: string | null;
  signOffSignedAt: Date | null;
};

const COMPATIBILITY_SELECT = `
  vb.id,
  vb.bast_document_id AS "rawBastDocumentId",
  vb.client_id AS "clientId",
  vb.vendor_work_id AS "vendorWorkId",
  vb.completion_report_id AS "completionReportId",
  vb.service_report_id AS "serviceReportId",
  vb.work_order_id AS "workOrderId",
  vb.building_id AS "buildingId",
  vb.bast_number AS "bastNumber",
  vb.bast_date AS "bastDate",
  vb.prepared_by_user_id AS "preparedByUserId",
  vb.submitted_by_user_id AS "legacySubmittedByUserId",
  vb.accepted_by_user_id AS "legacyAcceptedByUserId",
  vb.acceptance_status AS "legacyAcceptanceStatus",
  vb.notes,
  vb.file_reference AS "fileReference",
  vb.submitted_at AS "legacySubmittedAt",
  vb.accepted_at AS "legacyAcceptedAt",
  vb.created_at AS "createdAt",
  vb.updated_at AS "legacyUpdatedAt",
  bd.id AS "canonicalBastDocumentId",
  bd.client_id AS "canonicalClientId",
  bd.building_id AS "canonicalBuildingId",
  bd.work_order_id AS "canonicalWorkOrderId",
  bd.vendor_work_id AS "canonicalVendorWorkId",
  bd.completion_report_id AS "canonicalCompletionReportId",
  bd.service_report_id AS "canonicalServiceReportId",
  bd.bast_number AS "canonicalBastNumber",
  bd.acceptance_status AS "canonicalAcceptanceStatus",
  bd.submitted_by_user_id AS "canonicalSubmittedByUserId",
  bd.accepted_by_user_id AS "canonicalAcceptedByUserId",
  bd.submitted_at AS "canonicalSubmittedAt",
  bd.accepted_at AS "canonicalAcceptedAt",
  bd.updated_at AS "canonicalUpdatedAt",
  current_sign_off.id AS "signOffId",
  current_sign_off.bast_submission_attempt_id AS "signOffAttemptId",
  current_sign_off.document_version_id AS "signOffDocumentVersionId",
  current_sign_off.decision AS "signOffDecision",
  current_sign_off.signer_user_id AS "signOffSignerUserId",
  current_sign_off.notes AS "signOffNotes",
  current_sign_off.signed_at AS "signOffSignedAt"
`;

/**
 * The first join is Client/Building constrained so cross-scope canonical data
 * is never selected into the compatibility row. Work identity is validated by
 * the mapper before any canonical field is projected.
 */
const COMPATIBILITY_JOINS = `
  LEFT JOIN bast_documents bd
    ON bd.id = vb.bast_document_id
   AND bd.client_id = vb.client_id
   AND bd.building_id = vb.building_id
  LEFT JOIN LATERAL (
    SELECT attempt.id, attempt.document_version_id
    FROM bast_submission_attempts attempt
    WHERE attempt.bast_document_id = bd.id
    ORDER BY attempt.attempt_number DESC, attempt.id DESC
    LIMIT 1
  ) current_attempt ON TRUE
  LEFT JOIN LATERAL (
    SELECT aso.*
    FROM acceptance_sign_offs aso
    WHERE aso.bast_document_id = bd.id
      AND aso.bast_submission_attempt_id = current_attempt.id
      AND aso.document_version_id = current_attempt.document_version_id
    ORDER BY aso.signed_at DESC, aso.id DESC
    LIMIT 1
  ) current_sign_off ON TRUE
`;

function toDateString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return String(value).slice(0, 10);
}

function mapSignOff(
  row: VendorBastRow,
  projectCanonical: boolean,
): VendorBastAcceptanceSignOffRecord | null {
  if (
    !projectCanonical ||
    !row.signOffId ||
    !row.signOffAttemptId ||
    !row.signOffDocumentVersionId ||
    !row.signOffDecision ||
    !row.signOffSignerUserId ||
    !row.signOffSignedAt ||
    row.signOffDecision !== row.canonicalAcceptanceStatus
  ) {
    return null;
  }
  return {
    id: row.signOffId,
    bastSubmissionAttemptId: row.signOffAttemptId,
    documentVersionId: row.signOffDocumentVersionId,
    decision: row.signOffDecision,
    signerUserId: row.signOffSignerUserId,
    notes: row.signOffNotes,
    signedAt: row.signOffSignedAt,
  };
}

function mapRow(row: VendorBastRow): VendorBastRecord {
  const projectCanonical =
    row.rawBastDocumentId !== null &&
    row.canonicalBastDocumentId === row.rawBastDocumentId &&
    row.canonicalClientId === row.clientId &&
    row.canonicalBuildingId === row.buildingId &&
    row.canonicalWorkOrderId === row.workOrderId &&
    row.canonicalVendorWorkId === row.vendorWorkId &&
    row.canonicalAcceptanceStatus !== null;

  const canonicalLink =
    projectCanonical &&
    row.canonicalBastDocumentId &&
    row.canonicalClientId &&
    row.canonicalBuildingId &&
    row.canonicalWorkOrderId &&
    row.canonicalBastNumber &&
    row.canonicalAcceptanceStatus
      ? {
          id: row.canonicalBastDocumentId,
          clientId: row.canonicalClientId,
          buildingId: row.canonicalBuildingId,
          workOrderId: row.canonicalWorkOrderId,
          vendorWorkId: row.canonicalVendorWorkId,
          completionReportId: row.canonicalCompletionReportId,
          serviceReportId: row.canonicalServiceReportId,
          bastNumber: row.canonicalBastNumber,
          acceptanceStatus: row.canonicalAcceptanceStatus,
        }
      : null;

  const signOff = mapSignOff(row, projectCanonical);
  const signOffContradictsCanonical =
    projectCanonical &&
    row.signOffDecision !== null &&
    row.signOffDecision !== row.canonicalAcceptanceStatus;
  const linkedValuesDiverge =
    projectCanonical &&
    (row.canonicalBastNumber !== row.bastNumber ||
      row.canonicalCompletionReportId !== row.completionReportId ||
      row.canonicalServiceReportId !== row.serviceReportId ||
      row.canonicalAcceptanceStatus !== row.legacyAcceptanceStatus ||
      signOffContradictsCanonical);

  return {
    id: row.id,
    bastDocumentId: projectCanonical ? row.canonicalBastDocumentId : null,
    clientId: row.clientId,
    vendorWorkId: row.vendorWorkId,
    completionReportId: row.completionReportId,
    serviceReportId: row.serviceReportId,
    workOrderId: row.workOrderId,
    buildingId: row.buildingId,
    bastNumber: row.bastNumber,
    bastDate: toDateString(row.bastDate),
    preparedByUserId: row.preparedByUserId,
    submittedByUserId: projectCanonical
      ? row.canonicalSubmittedByUserId
      : row.legacySubmittedByUserId,
    acceptedByUserId: projectCanonical
      ? row.canonicalAcceptedByUserId
      : row.legacyAcceptedByUserId,
    acceptanceStatus:
      projectCanonical && row.canonicalAcceptanceStatus
        ? row.canonicalAcceptanceStatus
        : row.legacyAcceptanceStatus,
    notes: row.notes,
    fileReference: row.fileReference,
    submittedAt: projectCanonical
      ? row.canonicalSubmittedAt
      : row.legacySubmittedAt,
    acceptedAt: projectCanonical
      ? row.canonicalAcceptedAt
      : row.legacyAcceptedAt,
    createdAt: row.createdAt,
    updatedAt:
      projectCanonical && row.canonicalUpdatedAt
        ? row.canonicalUpdatedAt
        : row.legacyUpdatedAt,
    compatibility: {
      lifecycleAuthority: projectCanonical
        ? 'CANONICAL_BAST'
        : row.rawBastDocumentId
          ? 'UNRESOLVED_CANONICAL_LINK'
          : 'LEGACY_ONLY_FALLBACK',
      reconciliationRequired: !projectCanonical || linkedValuesDiverge,
      legacyAcceptanceStatus: row.legacyAcceptanceStatus,
    },
    acceptanceSignOff: signOff,
    canonicalLink,
  };
}

async function findById(id: string): Promise<VendorBastRecord | null> {
  const result = await getPool().query<VendorBastRow>(
    `SELECT ${COMPATIBILITY_SELECT}
     FROM vendor_bast_bindings vb
     ${COMPATIBILITY_JOINS}
     WHERE vb.id = $1`,
    [id],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

async function findByVendorWorkId(
  vendorWorkId: string,
): Promise<VendorBastRecord | null> {
  const result = await getPool().query<VendorBastRow>(
    `SELECT ${COMPATIBILITY_SELECT}
     FROM vendor_bast_bindings vb
     ${COMPATIBILITY_JOINS}
     WHERE vb.vendor_work_id = $1
     LIMIT 1`,
    [vendorWorkId],
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

/** Lists only legacy rows in the caller's authorized Building set. */
async function list(input: {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
  buildingIds: string[];
}): Promise<VendorBastRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  values.push(input.buildingIds);
  conditions.push(`vb.building_id = ANY($${values.length})`);
  if (input.vendorWorkId) {
    values.push(input.vendorWorkId);
    conditions.push(`vb.vendor_work_id = $${values.length}`);
  }
  if (input.vendorId) {
    values.push(input.vendorId);
    conditions.push(`vw.vendor_id = $${values.length}`);
  }
  if (input.buildingId) {
    values.push(input.buildingId);
    conditions.push(`vb.building_id = $${values.length}`);
  }

  const result = await getPool().query<VendorBastRow>(
    `SELECT ${COMPATIBILITY_SELECT}
     FROM vendor_bast_bindings vb
     ${COMPATIBILITY_JOINS}
     LEFT JOIN vendor_works vw ON vw.id = vb.vendor_work_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY vb.created_at ASC, vb.id ASC`,
    values,
  );
  return result.rows.map(mapRow);
}

export const vendorBastRepository = {
  findById,
  findByVendorWorkId,
  list,
};

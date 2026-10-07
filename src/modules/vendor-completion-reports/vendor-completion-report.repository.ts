import { randomUUID } from 'node:crypto';
import { getPool } from '../../database';
import type {
  CompletionReportStatus,
  VendorCompletionReportRecord,
} from './vendor-completion-report.types';

/**
 * BE-15F — Vendor Completion Report repository.
 *
 * Holds completion-report rows for a BE-15B Vendor Work. Change history is
 * preserved through the shared BE-07 operational-events timeline (recorded by
 * the service), not by extra rows here.
 */

export type NewVendorCompletionReport = {
  clientId: string;
  vendorWorkId: string;
  workOrderId: string;
  buildingId: string;
  summary: string | null;
  notes: string | null;
  evidenceReady: boolean;
  missingEvidenceTypes: string[];
  createdByUserId: string;
};

type VendorCompletionReportRow = {
  id: string;
  clientId: string;
  vendorWorkId: string;
  workOrderId: string;
  buildingId: string;
  completionStatus: CompletionReportStatus;
  summary: string | null;
  notes: string | null;
  completedByUserId: string | null;
  completedAt: Date | null;
  evidenceReady: boolean;
  missingEvidenceTypes: string[];
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

const REPORT_SELECT = `
  id,
  client_id AS "clientId",
  vendor_work_id AS "vendorWorkId",
  work_order_id AS "workOrderId",
  building_id AS "buildingId",
  completion_status AS "completionStatus",
  summary,
  notes,
  completed_by_user_id AS "completedByUserId",
  completed_at AS "completedAt",
  evidence_ready AS "evidenceReady",
  missing_evidence_types AS "missingEvidenceTypes",
  created_by_user_id AS "createdByUserId",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

function mapRow(row: VendorCompletionReportRow): VendorCompletionReportRecord {
  return {
    id: row.id,
    clientId: row.clientId,
    vendorWorkId: row.vendorWorkId,
    workOrderId: row.workOrderId,
    buildingId: row.buildingId,
    completionStatus: row.completionStatus,
    summary: row.summary,
    notes: row.notes,
    completedByUserId: row.completedByUserId,
    completedAt: row.completedAt,
    evidenceReady: row.evidenceReady,
    missingEvidenceTypes: row.missingEvidenceTypes ?? [],
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function create(
  input: NewVendorCompletionReport,
): Promise<VendorCompletionReportRecord> {
  const result = await getPool().query<VendorCompletionReportRow>(
    `INSERT INTO vendor_completion_reports
       (id, client_id, vendor_work_id, work_order_id, building_id,
        completion_status, summary, notes, evidence_ready,
        missing_evidence_types, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8, $9, $10)
     RETURNING ${REPORT_SELECT}`,
    [
      randomUUID(),
      input.clientId,
      input.vendorWorkId,
      input.workOrderId,
      input.buildingId,
      input.summary,
      input.notes,
      input.evidenceReady,
      JSON.stringify(input.missingEvidenceTypes),
      input.createdByUserId,
    ],
  );

  return mapRow(result.rows[0]);
}

async function findById(id: string): Promise<VendorCompletionReportRecord | null> {
  const result = await getPool().query<VendorCompletionReportRow>(
    `SELECT ${REPORT_SELECT} FROM vendor_completion_reports WHERE id = $1`,
    [id],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

async function findByVendorWorkId(
  vendorWorkId: string,
): Promise<VendorCompletionReportRecord | null> {
  const result = await getPool().query<VendorCompletionReportRow>(
    `SELECT ${REPORT_SELECT} FROM vendor_completion_reports
     WHERE vendor_work_id = $1
     LIMIT 1`,
    [vendorWorkId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/**
 * Lists reports scoped to the caller's accessible Building set, optionally
 * narrowed by Vendor Work / Vendor (via `vendor_works`) / Building.
 */
async function list(input: {
  vendorWorkId?: string;
  vendorId?: string;
  buildingId?: string;
  buildingIds: string[];
}): Promise<VendorCompletionReportRecord[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];

  values.push(input.buildingIds);
  conditions.push(`vcr.building_id = ANY($${values.length})`);

  if (input.vendorWorkId) {
    values.push(input.vendorWorkId);
    conditions.push(`vcr.vendor_work_id = $${values.length}`);
  }
  if (input.vendorId) {
    values.push(input.vendorId);
    conditions.push(`vw.vendor_id = $${values.length}`);
  }
  if (input.buildingId) {
    values.push(input.buildingId);
    conditions.push(`vcr.building_id = $${values.length}`);
  }

  const result = await getPool().query<VendorCompletionReportRow>(
    `SELECT
       vcr.id,
       vcr.client_id AS "clientId",
       vcr.vendor_work_id AS "vendorWorkId",
       vcr.work_order_id AS "workOrderId",
       vcr.building_id AS "buildingId",
       vcr.completion_status AS "completionStatus",
       vcr.summary,
       vcr.notes,
       vcr.completed_by_user_id AS "completedByUserId",
       vcr.completed_at AS "completedAt",
       vcr.evidence_ready AS "evidenceReady",
       vcr.missing_evidence_types AS "missingEvidenceTypes",
       vcr.created_by_user_id AS "createdByUserId",
       vcr.created_at AS "createdAt",
       vcr.updated_at AS "updatedAt"
     FROM vendor_completion_reports vcr
     LEFT JOIN vendor_works vw ON vw.id = vcr.vendor_work_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY vcr.created_at ASC`,
    values,
  );

  return result.rows.map(mapRow);
}

/** Updates the mutable DRAFT fields and the evidence-readiness snapshot. */
async function updateDraft(
  id: string,
  input: {
    summary: string | null;
    notes: string | null;
    evidenceReady: boolean;
    missingEvidenceTypes: string[];
  },
): Promise<VendorCompletionReportRecord | null> {
  const result = await getPool().query<VendorCompletionReportRow>(
    `UPDATE vendor_completion_reports
     SET summary = $2,
         notes = $3,
         evidence_ready = $4,
         missing_evidence_types = $5,
         updated_at = NOW()
     WHERE id = $1 AND completion_status = 'DRAFT'
     RETURNING ${REPORT_SELECT}`,
    [
      id,
      input.summary,
      input.notes,
      input.evidenceReady,
      JSON.stringify(input.missingEvidenceTypes),
    ],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

/** Finalizes a DRAFT report (DRAFT → SUBMITTED) with the completing actor. */
async function finalize(
  id: string,
  completedByUserId: string,
): Promise<VendorCompletionReportRecord | null> {
  const result = await getPool().query<VendorCompletionReportRow>(
    `UPDATE vendor_completion_reports
     SET completion_status = 'SUBMITTED',
         completed_by_user_id = $2,
         completed_at = NOW(),
         evidence_ready = TRUE,
         missing_evidence_types = '[]'::jsonb,
         updated_at = NOW()
     WHERE id = $1 AND completion_status = 'DRAFT'
     RETURNING ${REPORT_SELECT}`,
    [id, completedByUserId],
  );

  const row = result.rows[0];
  return row ? mapRow(row) : null;
}

export const vendorCompletionReportRepository = {
  create,
  finalize,
  findById,
  findByVendorWorkId,
  list,
  updateDraft,
};

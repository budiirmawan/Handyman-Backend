import type { PoolClient } from 'pg';
import { getPool } from '../../database';
import type {
  HandymanInspectionReportEstimateRecord,
  HandymanInspectionReportRecord,
  HandymanInspectionReportReviewRecord,
  NewHandymanInspectionReportEstimateRecord,
  NewHandymanInspectionReportRecord,
  NewHandymanInspectionReportReviewRecord,
} from './handyman-request-inspection-report.types';

/**
 * CR-HM-INSPECTION-01 PART B — versioned report repository (executor-first
 * convention identical to the sibling Handyman repositories: shared pool by
 * default; transaction executor as argument ONE).
 *
 * Bounded to INSERT (append) and the reads the report/review services need.
 * No UPDATE/DELETE exists here; the 0446 triggers refuse them for every
 * other actor too.
 */

type ReportRow = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  channel_attribution_id: string;
  building_id: string;
  handyman_request_inspection_id: string;
  inspection_assignment_id: string;
  version_number: number;
  supersedes_report_id: string | null;
  submitted_by_user_id: string;
  submitted_at: Date;
  technical_findings: string;
  proposed_diagnosis: string;
  handyman_discipline_id: string;
  discipline_code: string;
  scope_classification: HandymanInspectionReportRecord['scopeClassification'];
  recommended_service_catalog_id: string | null;
};

type EstimateRow = {
  id: string;
  client_id: string;
  report_id: string;
  line_type: HandymanInspectionReportEstimateRecord['lineType'];
  description: string;
  quantity: string;
  uom_id: string;
  created_at: Date;
};

type ReviewRow = {
  id: string;
  client_id: string;
  handyman_request_id: string;
  building_id: string;
  report_id: string;
  report_submitted_by_user_id: string;
  decision: HandymanInspectionReportReviewRecord['decision'];
  return_reason: string | null;
  reviewed_by_user_id: string;
  reviewed_at: Date;
};

const REPORT_SELECT = `
  SELECT id, client_id, handyman_request_id, channel_attribution_id,
         building_id, handyman_request_inspection_id,
         inspection_assignment_id, version_number, supersedes_report_id,
         submitted_by_user_id, submitted_at, technical_findings,
         proposed_diagnosis, handyman_discipline_id, discipline_code,
         scope_classification, recommended_service_catalog_id
    FROM handyman_request_inspection_reports`;

const REVIEW_SELECT = `
  SELECT id, client_id, handyman_request_id, building_id, report_id,
         report_submitted_by_user_id, decision, return_reason,
         reviewed_by_user_id, reviewed_at
    FROM handyman_request_inspection_report_reviews`;

function mapReport(row: ReportRow): HandymanInspectionReportRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    channelAttributionId: row.channel_attribution_id,
    buildingId: row.building_id,
    handymanRequestInspectionId: row.handyman_request_inspection_id,
    inspectionAssignmentId: row.inspection_assignment_id,
    versionNumber: row.version_number,
    supersedesReportId: row.supersedes_report_id,
    submittedByUserId: row.submitted_by_user_id,
    submittedAt: row.submitted_at,
    technicalFindings: row.technical_findings,
    proposedDiagnosis: row.proposed_diagnosis,
    handymanDisciplineId: row.handyman_discipline_id,
    disciplineCode: row.discipline_code,
    scopeClassification: row.scope_classification,
    recommendedServiceCatalogId: row.recommended_service_catalog_id,
  };
}

function mapEstimate(
  row: EstimateRow,
): HandymanInspectionReportEstimateRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    reportId: row.report_id,
    lineType: row.line_type,
    description: row.description,
    quantity: Number(row.quantity),
    uomId: row.uom_id,
    createdAt: row.created_at,
  };
}

function mapReview(row: ReviewRow): HandymanInspectionReportReviewRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    handymanRequestId: row.handyman_request_id,
    buildingId: row.building_id,
    reportId: row.report_id,
    reportSubmittedByUserId: row.report_submitted_by_user_id,
    decision: row.decision,
    returnReason: row.return_reason,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at,
  };
}

async function insertReport(
  executor: Pick<PoolClient, 'query'> = getPool(),
  record: NewHandymanInspectionReportRecord,
): Promise<HandymanInspectionReportRecord> {
  const result = await executor.query<ReportRow>(
    `INSERT INTO handyman_request_inspection_reports (
       id, client_id, handyman_request_id, channel_attribution_id,
       building_id, handyman_request_inspection_id,
       inspection_assignment_id, version_number, supersedes_report_id,
       submitted_by_user_id, technical_findings, proposed_diagnosis,
       handyman_discipline_id, discipline_code, scope_classification,
       recommended_service_catalog_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
               $14, $15, $16)
     RETURNING id, client_id, handyman_request_id, channel_attribution_id,
               building_id, handyman_request_inspection_id,
               inspection_assignment_id, version_number, supersedes_report_id,
               submitted_by_user_id, submitted_at, technical_findings,
               proposed_diagnosis, handyman_discipline_id, discipline_code,
               scope_classification, recommended_service_catalog_id`,
    [
      record.id,
      record.clientId,
      record.handymanRequestId,
      record.channelAttributionId,
      record.buildingId,
      record.handymanRequestInspectionId,
      record.inspectionAssignmentId,
      record.versionNumber,
      record.supersedesReportId,
      record.submittedByUserId,
      record.technicalFindings,
      record.proposedDiagnosis,
      record.handymanDisciplineId,
      record.disciplineCode,
      record.scopeClassification,
      record.recommendedServiceCatalogId,
    ],
  );
  return mapReport(result.rows[0]);
}

async function insertEstimate(
  executor: Pick<PoolClient, 'query'>,
  record: NewHandymanInspectionReportEstimateRecord,
): Promise<HandymanInspectionReportEstimateRecord> {
  const result = await executor.query<EstimateRow>(
    `INSERT INTO handyman_request_inspection_report_estimates (
       id, client_id, report_id, line_type, description, quantity, uom_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, client_id, report_id, line_type, description, quantity,
               uom_id, created_at`,
    [
      record.id,
      record.clientId,
      record.reportId,
      record.lineType,
      record.description,
      record.quantity,
      record.uomId,
    ],
  );
  return mapEstimate(result.rows[0]);
}

async function insertReview(
  executor: Pick<PoolClient, 'query'>,
  record: NewHandymanInspectionReportReviewRecord,
): Promise<HandymanInspectionReportReviewRecord> {
  const result = await executor.query<ReviewRow>(
    `INSERT INTO handyman_request_inspection_report_reviews (
       id, client_id, handyman_request_id, building_id, report_id,
       report_submitted_by_user_id, decision, return_reason,
       reviewed_by_user_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, handyman_request_id, building_id, report_id,
               report_submitted_by_user_id, decision, return_reason,
               reviewed_by_user_id, reviewed_at`,
    [
      record.id,
      record.clientId,
      record.handymanRequestId,
      record.buildingId,
      record.reportId,
      record.reportSubmittedByUserId,
      record.decision,
      record.returnReason,
      record.reviewedByUserId,
    ],
  );
  return mapReview(result.rows[0]);
}

async function findLatestByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanInspectionReportRecord | null> {
  const result = await executor.query<ReportRow>(
    `${REPORT_SELECT}
      WHERE handyman_request_id = $1
      ORDER BY version_number DESC
      LIMIT 1`,
    [handymanRequestId],
  );
  return result.rows[0] ? mapReport(result.rows[0]) : null;
}

async function listByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanInspectionReportRecord[]> {
  const result = await executor.query<ReportRow>(
    `${REPORT_SELECT}
      WHERE handyman_request_id = $1
      ORDER BY version_number ASC`,
    [handymanRequestId],
  );
  return result.rows.map(mapReport);
}

async function findByRequestAndId(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
  reportId: string,
): Promise<HandymanInspectionReportRecord | null> {
  const result = await executor.query<ReportRow>(
    `${REPORT_SELECT}
      WHERE handyman_request_id = $1 AND id = $2`,
    [handymanRequestId, reportId],
  );
  return result.rows[0] ? mapReport(result.rows[0]) : null;
}

async function listEstimatesByReport(
  executor: Pick<PoolClient, 'query'> = getPool(),
  reportId: string,
): Promise<HandymanInspectionReportEstimateRecord[]> {
  const result = await executor.query<EstimateRow>(
    `SELECT id, client_id, report_id, line_type, description, quantity,
            uom_id, created_at
       FROM handyman_request_inspection_report_estimates
      WHERE report_id = $1
      ORDER BY created_at ASC, id ASC`,
    [reportId],
  );
  return result.rows.map(mapEstimate);
}

async function findReviewByReport(
  executor: Pick<PoolClient, 'query'> = getPool(),
  reportId: string,
): Promise<HandymanInspectionReportReviewRecord | null> {
  const result = await executor.query<ReviewRow>(
    `${REVIEW_SELECT} WHERE report_id = $1`,
    [reportId],
  );
  return result.rows[0] ? mapReview(result.rows[0]) : null;
}

async function findAcceptedReviewByRequest(
  executor: Pick<PoolClient, 'query'> = getPool(),
  handymanRequestId: string,
): Promise<HandymanInspectionReportReviewRecord | null> {
  const result = await executor.query<ReviewRow>(
    `${REVIEW_SELECT}
      WHERE handyman_request_id = $1 AND decision = 'ACCEPTED'
        AND report_id IN (SELECT id FROM handyman_request_inspection_reports
          WHERE handyman_request_inspection_id=(SELECT id FROM handyman_request_inspections
            WHERE handyman_request_id=$1 ORDER BY attempt_number DESC LIMIT 1))`,
    [handymanRequestId],
  );
  return result.rows[0] ? mapReview(result.rows[0]) : null;
}

async function hasPendingReview(
  executor: Pick<PoolClient, 'query'>,
  handymanRequestId: string,
): Promise<boolean> {
  const result = await executor.query<{ pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM handyman_request_inspection_reports rp
         LEFT JOIN handyman_request_inspection_report_reviews rv
           ON rv.report_id = rp.id
        WHERE rp.handyman_request_id = $1
          AND rv.id IS NULL
     ) AS pending`,
    [handymanRequestId],
  );
  return result.rows[0]?.pending === true;
}

export const handymanRequestInspectionReportRepository = {
  findAcceptedReviewByRequest,
  findByRequestAndId,
  findLatestByRequest,
  findReviewByReport,
  hasPendingReview,
  insertEstimate,
  insertReport,
  insertReview,
  listByRequest,
  listEstimatesByReport,
};

import { assertRequestOpen } from './handyman-prequotation-operations.service';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AppError } from '../../shared/errors';
import { isValidUuid } from '../clients';
import { withTransaction } from '../../database';
import { assertBuildingScopedResourceAccess } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { handymanDisciplineRepository } from '../handyman-disciplines';
import { serviceCatalogRepository } from '../service-catalog';
import { handymanServiceRequestRepository } from './handyman-service-request.repository';
import { handymanRequestInspectionRepository } from './handyman-request-inspection.repository';
import { handymanRequestInspectionReportRepository as repository } from './handyman-request-inspection-report.repository';
import { assertAssignedFieldInspector } from './handyman-request-inspection-assignment.service';
import {
  handymanInspectionReportAlreadyAcceptedError,
  handymanInspectionReportAlreadyReviewedError,
  handymanInspectionReportEstimateInvalidError,
  handymanInspectionReportInspectionRequiredError,
  handymanInspectionReportNotLatestError,
  handymanInspectionReportNotFoundError,
  handymanInspectionReportPendingReviewError,
  handymanInspectionReportRecommendationInvalidError,
  handymanInspectionReportReturnReasonRequiredError,
  handymanInspectionReportSelfReviewDeniedError,
  handymanInspectionReportVersionConflictError,
} from './handyman-request-inspection-report.errors';
import { handymanInspectionFieldDeniedError } from './handyman-request-inspection-assignment.errors';
import { handymanServiceRequestNotFoundError } from './handyman-request-triage.errors';
import { handymanDisciplineInvalidError } from '../handyman-disciplines';
import {
  SCOPE_CLASS_TO_CLASSIFICATION,
} from './handyman-request-diagnosis.types';
import {
  isHandymanInspectionEstimateLineType,
  type HandymanInspectionReportRecord,
  type HandymanInspectionReportReviewRecord,
  type HandymanInspectionReportStatus,
  type PublicHandymanInspectionReport,
  type PublicHandymanInspectionReportThread,
  type ReviewHandymanInspectionReportInput,
  type SubmitHandymanInspectionReportInput,
} from './handyman-request-inspection-report.types';

/**
 * CR-HM-INSPECTION-01 PART B — versioned Field report + Operations review
 * service.
 *
 * Bounded to: the assigned Field inspector's immutable versioned report
 * submission for the request's single 0381 physical inspection, and the
 * Operations ACCEPTED/RETURNED decision (exactly one per version, reviewer
 * different from that version's submitter).
 *
 * Authority (FROZEN F7): the submitter is the authenticated local user and
 * must BE the request's ACTIVE assigned Field inspector; the reviewer is the
 * authenticated local user with the dedicated review authority and the exact
 * Building scope derived from the request. Report state is DERIVED from the
 * immutable review row — no request status is written or invented (FROZEN
 * F1), and the classification stays server-derived (FROZEN F9).
 *
 * NOT here: no evidence (F3 defers to CR-HM-10), no price/amount/currency or
 * quotation line (CR-HM-06/CR-HM-12 own commercial authority), no second
 * physical inspection or reinspection, no PIC, Execution Scope, provider or
 * crew identity.
 */

const REPORT_VERSION_UNIQUE =
  'handyman_request_inspection_report_version_unique';
const REVIEW_ONE_PER_VERSION =
  'handyman_request_inspection_review_one_per_version';
const REVIEW_ACCEPTED_UNIQUE =
  'handyman_request_inspection_review_accepted_unique';
const MAX_ESTIMATE_LINES = 50;

function isUniqueViolation(error: unknown, constraint: string): boolean {
  const candidate = error as { code?: string; constraint?: string };
  return candidate?.code === '23505' && candidate?.constraint === constraint;
}

function assertUuid(value: string | undefined, field: string): void {
  if (value === undefined || !isValidUuid(value)) {
    throw AppError.validation('Request validation failed.', [
      { field, message: `${field} must be a valid UUID.` },
    ]);
  }
}

function readBoundedText(
  value: unknown,
  field: string,
  max: number,
  details: Array<{ field: string; message: string }>,
): string {
  if (typeof value !== 'string') {
    details.push({ field, message: `${field} is required.` });
    return '';
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) {
    details.push({
      field,
      message: `${field} must be between 1 and ${max} characters.`,
    });
  }
  return trimmed;
}

function reportStatus(
  review: HandymanInspectionReportReviewRecord | null,
): HandymanInspectionReportStatus {
  if (!review) return 'PENDING_REVIEW';
  return review.decision === 'ACCEPTED' ? 'ACCEPTED' : 'RETURNED';
}

function toPublicReview(review: HandymanInspectionReportReviewRecord) {
  return { ...review, reviewedAt: review.reviewedAt.toISOString() };
}

async function toPublicReport(
  executor: Pick<PoolClient, 'query'> | undefined,
  record: HandymanInspectionReportRecord,
): Promise<PublicHandymanInspectionReport> {
  const [estimates, review] = await Promise.all([
    repository.listEstimatesByReport(executor, record.id),
    repository.findReviewByReport(executor, record.id),
  ]);
  return {
    ...record,
    submittedAt: record.submittedAt.toISOString(),
    status: reportStatus(review),
    estimates: estimates.map((line) => ({
      ...line,
      createdAt: line.createdAt.toISOString(),
    })),
    review: review ? toPublicReview(review) : null,
  };
}

/**
 * Validate the technical estimate lines: LABOR/MATERIAL, bounded description,
 * positive quantity, existing ACTIVE unit of measure of the same Client.
 * There is deliberately NO price/amount/currency input to validate.
 */
function parseEstimates(
  value: unknown,
): Array<{
  lineType: 'LABOR' | 'MATERIAL';
  description: string;
  quantity: number;
  uomId: string;
}> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ESTIMATE_LINES) {
    throw handymanInspectionReportEstimateInvalidError();
  }
  const lines: Array<{
    lineType: 'LABOR' | 'MATERIAL';
    description: string;
    quantity: number;
    uomId: string;
  }> = [];
  for (const raw of value) {
    const source = (typeof raw === 'object' && raw !== null ? raw : {}) as
      Record<string, unknown>;
    if (!isHandymanInspectionEstimateLineType(source.lineType)) {
      throw handymanInspectionReportEstimateInvalidError();
    }
    const description =
      typeof source.description === 'string' ? source.description.trim() : '';
    if (description.length < 1 || description.length > 500) {
      throw handymanInspectionReportEstimateInvalidError();
    }
    const quantity =
      typeof source.quantity === 'number'
        ? source.quantity
        : Number(source.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw handymanInspectionReportEstimateInvalidError();
    }
    if (typeof source.uomId !== 'string' || !isValidUuid(source.uomId.trim())) {
      throw handymanInspectionReportEstimateInvalidError();
    }
    lines.push({
      lineType: source.lineType,
      description,
      quantity,
      uomId: source.uomId.trim().toLowerCase(),
    });
  }
  return lines;
}

/** The Client's ACTIVE units of measure, for the batch just parsed. */
async function assertActiveUoms(
  tx: PoolClient,
  clientId: string,
  uomIds: readonly string[],
): Promise<void> {
  if (uomIds.length === 0) return;
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM units_of_measure
      WHERE client_id = $1 AND status = 'ACTIVE' AND id = ANY($2::uuid[])`,
    [clientId, uomIds],
  );
  const found = new Set(result.rows.map((row) => row.id));
  if (uomIds.some((id) => !found.has(id))) {
    throw handymanInspectionReportEstimateInvalidError();
  }
}

/**
 * Submit the next report version for the request's 0381 inspection.
 *
 * Version 1 may only be submitted by the assigned Field user who is also the
 * recorded physical inspector; a correction version follows a `RETURNED`
 * decision and never edits its predecessor.
 */
export async function submitHandymanInspectionReport(
  input: SubmitHandymanInspectionReportInput,
  actorUserId: string,
): Promise<PublicHandymanInspectionReport> {
  if (!isValidUuid(input.handymanRequestId)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'handymanRequestId',
        message: 'handymanRequestId must be a valid UUID.',
      },
    ]);
  }
  assertUuid(input.disciplineId, 'disciplineId');
  assertUuid(actorUserId, 'actorUserId');
  if (
    input.recommendedServiceCatalogId != null &&
    !isValidUuid(input.recommendedServiceCatalogId)
  ) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'recommendedServiceCatalogId',
        message: 'recommendedServiceCatalogId must be a valid UUID when present.',
      },
    ]);
  }
  const details: Array<{ field: string; message: string }> = [];
  const findings = readBoundedText(
    input.technicalFindings,
    'technicalFindings',
    2000,
    details,
  );
  const proposedDiagnosis = readBoundedText(
    input.proposedDiagnosis,
    'proposedDiagnosis',
    1000,
    details,
  );
  if (details.length) throw AppError.validation('Request validation failed.', details);
  const estimateLines = parseEstimates(input.estimates);

  try {
    return await withTransaction(async (tx) => {
      const request = await handymanServiceRequestRepository.lockById(
        tx,
        input.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();
      assertRequestOpen(request);
      if (request.status === 'INSPECTION_REQUIRED') throw handymanInspectionReportInspectionRequiredError();

      // Realm authority first (BE-02G exact Building; no same-Client shortcut).
      await assertBuildingScopedResourceAccess(actorUserId, {
        clientId: request.clientId,
        buildingId: request.buildingId,
      });

      // Single writer: the actor must be the ACTIVE assigned Field inspector.
      const assignment = await assertAssignedFieldInspector(
        tx,
        request.id,
        actorUserId,
      );

      // The version documents the request's ONE recorded physical inspection.
      const inspection = await handymanRequestInspectionRepository
        .findByRequest(tx, request.id);
      if (!inspection) throw handymanInspectionReportInspectionRequiredError();

      // Chain state (serialized by the request lock).
      const accepted = await repository.findAcceptedReviewByRequest(
        tx,
        request.id,
      );
      if (accepted) throw handymanInspectionReportAlreadyAcceptedError();
      const latest = await repository.findLatestByRequest(tx, request.id);
      let supersedesReportId: string | null = null;
      let versionNumber = 1;
      if (latest) {
        const latestReview = await repository.findReviewByReport(
          tx,
          latest.id,
        );
        if (!latestReview) throw handymanInspectionReportPendingReviewError();
        versionNumber = latest.versionNumber + 1;
        supersedesReportId = latest.id;
      }
      if ((!latest || latest.handymanRequestInspectionId !== inspection.id) && inspection.inspectedByUserId !== actorUserId) {
        // Version 1 must come from the recorded physical inspector; a later
        // version may come from a replacement assignee without rewriting 0381.
        throw handymanInspectionFieldDeniedError();
      }

      // F9 authority: the selected discipline is the scope root and the
      // classification is SERVER-derived from it (never a caller input).
      const discipline = await handymanDisciplineRepository.findDisciplineById(
        tx,
        input.disciplineId,
      );
      if (!discipline || discipline.status !== 'ACTIVE') {
        throw handymanDisciplineInvalidError();
      }
      const scopeClassification =
        SCOPE_CLASS_TO_CLASSIFICATION[discipline.scopeClass];

      // Optional catalogue anchor: ACTIVE, same Client, associated with the
      // selected discipline (free-text category is never authority).
      if (input.recommendedServiceCatalogId != null) {
        const catalog = await serviceCatalogRepository.findById(
          tx,
          input.recommendedServiceCatalogId,
        );
        if (
          !catalog ||
          catalog.status !== 'ACTIVE' ||
          catalog.clientId !== request.clientId
        ) {
          throw handymanInspectionReportRecommendationInvalidError();
        }
        const association =
          await handymanDisciplineRepository.findAssociationByCatalog(
            tx,
            input.recommendedServiceCatalogId,
          );
        if (!association || !association.handymanDisciplineId) {
          throw handymanInspectionReportRecommendationInvalidError();
        }
        if (association.handymanDisciplineId !== discipline.id) {
          throw handymanInspectionReportRecommendationInvalidError();
        }
      }

      await assertActiveUoms(tx, request.clientId, [
        ...new Set(estimateLines.map((line) => line.uomId)),
      ]);

      const report = await repository.insertReport(tx, {
        id: randomUUID(),
        clientId: request.clientId,
        handymanRequestId: request.id,
        channelAttributionId: request.channelAttributionId,
        buildingId: request.buildingId,
        handymanRequestInspectionId: inspection.id,
        inspectionAssignmentId: assignment.id,
        versionNumber,
        supersedesReportId,
        submittedByUserId: actorUserId,
        technicalFindings: findings,
        proposedDiagnosis,
        handymanDisciplineId: discipline.id,
        disciplineCode: discipline.code,
        scopeClassification,
        recommendedServiceCatalogId:
          input.recommendedServiceCatalogId ?? null,
      });

      for (const line of estimateLines) {
        await repository.insertEstimate(tx, {
          id: randomUUID(),
          clientId: request.clientId,
          reportId: report.id,
          lineType: line.lineType,
          description: line.description,
          quantity: line.quantity,
          uomId: line.uomId,
        });
      }

      await recordOperationalEvent(
        {
          clientId: request.clientId,
          eventType: 'HANDYMAN_INSPECTION_REPORT_SUBMITTED',
          entityType: 'HANDYMAN_SERVICE_REQUEST',
          entityId: request.id,
          actorUserId,
          buildingId: request.buildingId,
          summary: `Handyman Field inspection report v${versionNumber} submitted.`,
          metadata: {
            reportId: report.id,
            versionNumber,
            ...(supersedesReportId
              ? { supersedesReportId }
              : {}),
            estimateLineCount: estimateLines.length,
          },
        },
        tx,
      );

      return await toPublicReport(tx, report);
    });
  } catch (error) {
    if (isUniqueViolation(error, REPORT_VERSION_UNIQUE)) {
      throw handymanInspectionReportVersionConflictError();
    }
    throw error;
  }
}

/**
 * Record the ONE immutable ACCEPTED/RETURNED decision for the latest report
 * version. The reviewer must differ from that version's submitter, and only
 * the latest version may be decided.
 */
export async function reviewHandymanInspectionReport(
  input: ReviewHandymanInspectionReportInput,
  actorUserId: string,
): Promise<PublicHandymanInspectionReport> {
  assertUuid(input.handymanRequestId, 'handymanRequestId');
  assertUuid(input.reportId, 'reportId');
  assertUuid(actorUserId, 'actorUserId');
  if (input.decision !== 'ACCEPTED' && input.decision !== 'RETURNED') {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'decision',
        message: 'decision must be one of: ACCEPTED, RETURNED.',
      },
    ]);
  }
  const returnReason =
    typeof input.returnReason === 'string' ? input.returnReason.trim() : '';
  if (returnReason.length > 1000) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'returnReason',
        message: 'returnReason must be between 1 and 1000 characters.',
      },
    ]);
  }
  if (input.decision === 'RETURNED' && returnReason.length < 1) {
    throw handymanInspectionReportReturnReasonRequiredError();
  }

  try {
    return await withTransaction(async (tx) => {
      const request = await handymanServiceRequestRepository.lockById(
        tx,
        input.handymanRequestId,
      );
      if (!request) throw handymanServiceRequestNotFoundError();
      assertRequestOpen(request);
      if (request.status === 'INSPECTION_REQUIRED') throw handymanInspectionReportInspectionRequiredError();

      await assertBuildingScopedResourceAccess(actorUserId, {
        clientId: request.clientId,
        buildingId: request.buildingId,
      });

      const report = await repository.findByRequestAndId(
        tx,
        request.id,
        input.reportId,
      );
      if (!report) throw handymanInspectionReportNotFoundError();

      // Separation of duties: never your own submission (DB-enforced too).
      if (report.submittedByUserId === actorUserId) {
        throw handymanInspectionReportSelfReviewDeniedError();
      }

      const latest = await repository.findLatestByRequest(tx, request.id);
      if (!latest || latest.id !== report.id) {
        throw handymanInspectionReportNotLatestError();
      }
      const existing = await repository.findReviewByReport(tx, report.id);
      if (existing) throw handymanInspectionReportAlreadyReviewedError();

      const review = await repository.insertReview(tx, {
        id: randomUUID(),
        clientId: request.clientId,
        handymanRequestId: request.id,
        buildingId: request.buildingId,
        reportId: report.id,
        reportSubmittedByUserId: report.submittedByUserId,
        decision: input.decision,
        returnReason: input.decision === 'RETURNED' ? returnReason : null,
        reviewedByUserId: actorUserId,
      });

      await recordOperationalEvent(
        {
          clientId: request.clientId,
          eventType: 'HANDYMAN_INSPECTION_REPORT_REVIEWED',
          entityType: 'HANDYMAN_SERVICE_REQUEST',
          entityId: request.id,
          actorUserId,
          buildingId: request.buildingId,
          summary: `Handyman Field inspection report v${report.versionNumber} ${input.decision.toLowerCase()}.`,
          metadata: {
            reportId: report.id,
            reviewId: review.id,
            versionNumber: report.versionNumber,
            decision: review.decision,
          },
        },
        tx,
      );

      return await toPublicReport(tx, report);
    });
  } catch (error) {
    if (isUniqueViolation(error, REVIEW_ONE_PER_VERSION)) {
      throw handymanInspectionReportAlreadyReviewedError();
    }
    if (isUniqueViolation(error, REVIEW_ACCEPTED_UNIQUE)) {
      throw handymanInspectionReportAlreadyAcceptedError();
    }
    throw error;
  }
}

/** Bounded read of one report version (lines + decision) by request. */
export async function getHandymanInspectionReport(
  handymanRequestId: string,
  reportId: string,
  actorUserId?: string,
): Promise<PublicHandymanInspectionReport> {
  assertUuid(handymanRequestId, 'handymanRequestId');
  assertUuid(reportId, 'reportId');
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (actorUserId !== undefined) {
    assertUuid(actorUserId, 'actorUserId');
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: request.clientId,
      buildingId: request.buildingId,
    });
  }
  const report = await repository.findByRequestAndId(
    undefined,
    request.id,
    reportId,
  );
  if (!report) throw handymanInspectionReportNotFoundError();
  return toPublicReport(undefined, report);
}

/** Bounded read of the whole version thread of one request. */
export async function listHandymanInspectionReports(
  handymanRequestId: string,
  actorUserId?: string,
): Promise<PublicHandymanInspectionReportThread> {
  assertUuid(handymanRequestId, 'handymanRequestId');
  const request = await handymanServiceRequestRepository.findById(
    undefined,
    handymanRequestId,
  );
  if (!request) throw handymanServiceRequestNotFoundError();
  if (actorUserId !== undefined) {
    assertUuid(actorUserId, 'actorUserId');
    await assertBuildingScopedResourceAccess(actorUserId, {
      clientId: request.clientId,
      buildingId: request.buildingId,
    });
  }
  const records = await repository.listByRequest(undefined, request.id);
  const reports: PublicHandymanInspectionReport[] = [];
  for (const record of records) {
    reports.push(await toPublicReport(undefined, record));
  }
  return { reports };
}

/**
 * Reassignment bound used by PART A: refused while the latest version is
 * pending review and after ANY version has been accepted. `RETURNED` leaves
 * the request reassignable so a correction may be produced by a replacement
 * Field user (0381 inspector history is never rewritten).
 */
export async function isHandymanInspectionReassignmentAllowed(
  executor: Pick<PoolClient, 'query'>,
  handymanRequestId: string,
): Promise<boolean> {
  const accepted = await repository.findAcceptedReviewByRequest(
    executor,
    handymanRequestId,
  );
  if (accepted) return false;
  return !(await repository.hasPendingReview(executor, handymanRequestId));
}

export const handymanRequestInspectionReportService = {
  getHandymanInspectionReport,
  listHandymanInspectionReports,
  reviewHandymanInspectionReport,
  submitHandymanInspectionReport,
};

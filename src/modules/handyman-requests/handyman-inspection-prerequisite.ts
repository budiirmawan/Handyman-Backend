import type { PoolClient } from 'pg';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { handymanRequestTriageRepository } from './handyman-request-triage.repository';
import { handymanRequestInspectionReportRepository as reports } from './handyman-request-inspection-report.repository';
import { handymanRequestInspectionRepository } from './handyman-request-inspection.repository';
import type { HandymanRequestDiagnosisRecord } from './handyman-request-diagnosis.types';

function acceptedReportRequired(): AppError {
  return new AppError({
    code: ERROR_CODES.HANDYMAN_INSPECTION_ACCEPTED_REPORT_REQUIRED,
    message: 'This inspection-required request needs its latest Field report accepted by Operations.',
    statusCode: 409,
  });
}

/**
 * PART C: callers hold the parent request lock and have checked Building access.
 * Persisted triage, not the mutable request status or caller input, selects the
 * inspection path. Direct policy is enforced separately by the direct-policy
 * prerequisite; no missing-data grandfathering.
 */
export async function resolveAcceptedInspectionReport(
  tx: Pick<PoolClient, 'query'>,
  requestId: string,
) {
  const triage = await handymanRequestTriageRepository.findByRequest(tx, requestId);
  if (triage?.triageDisposition !== 'INSPECTION_REQUIRED') return null;

  const accepted = await reports.findAcceptedReviewByRequest(tx, requestId);
  const latest = await reports.findLatestByRequest(tx, requestId);
  if (!accepted || !latest || accepted.reportId !== latest.id) {
    throw acceptedReportRequired();
  }
  return latest;
}

/** Initial and revision DRAFT prerequisite only; never an issue/approval gate. */
export async function assertInspectionQuotationPrerequisite(
  tx: Pick<PoolClient, 'query'>,
  requestId: string,
  diagnosis: HandymanRequestDiagnosisRecord | null,
): Promise<boolean> {
  const report = await resolveAcceptedInspectionReport(tx, requestId);
  if (!report) return false;

  const inspection = await handymanRequestInspectionRepository.findByRequest(tx, requestId);
  if (!inspection || inspection.id !== report.handymanRequestInspectionId ||
      inspection.inspectionResult !== 'INSPECTED') {
    throw new AppError({
      code: ERROR_CODES.HANDYMAN_INSPECTION_NOT_QUOTABLE,
      message: 'A NOT_INSPECTABLE or missing physical inspection cannot authorize a quotation draft.',
      statusCode: 409,
    });
  }
  if (!diagnosis || diagnosis.sourceInspectionReportId !== report.id) {
    throw new AppError({
      code: ERROR_CODES.HANDYMAN_INSPECTION_DIAGNOSIS_SOURCE_REQUIRED,
      message: 'The diagnosis must reference this request\'s accepted inspection report.',
      statusCode: 409,
    });
  }
  return true;
}

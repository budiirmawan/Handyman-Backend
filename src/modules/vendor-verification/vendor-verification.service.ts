import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { vendorBastRepository } from '../vendor-bast-bindings';
import { vendorCompletionReportRepository } from '../vendor-completion-reports';
import { vendorServiceReportRepository } from '../vendor-service-reports';
import {
  vendorWorkNotFoundError,
  vendorWorkRepository,
} from '../vendor-work';
import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import {
  vendorVerificationAlreadyApprovedError,
  vendorVerificationBuildingMismatchError,
  vendorVerificationCompletionNotSubmittedError,
  vendorVerificationInvalidStateError,
} from './vendor-verification.errors';
import { vendorVerificationRepository } from './vendor-verification.repository';
import type {
  PublicVendorVerification,
  SubmitVendorVerificationInput,
  VendorVerificationContext,
  VendorVerificationState,
} from './vendor-verification.types';

/**
 * BE-15I — Vendor Work Verification service.
 *
 * Reuses the BE-07 Review & Verification primitive (`reviews`) — no separate
 * Vendor verification engine. A COMPLETED Vendor Work is verified with
 * APPROVED / REJECTED / REWORK_REQUIRED.
 *
 * Rules:
 *   - the Vendor Work must exist and be COMPLETED (BE-15B);
 *   - a Completion Report, when present, must be SUBMITTED (BE-15F);
 *   - the Work Order Building must match the Vendor Work Building (BE-08);
 *   - an already-APPROVED Vendor Work cannot be re-verified (final);
 *   - every submission inserts a fresh review row, so a completed
 *     verification is never silently overwritten.
 *
 * Rework is deliberately NOT implemented here (BE-15J owns it):
 * REWORK_REQUIRED only records the decision and never mutates the Vendor
 * Work's status.
 */
async function resolveVendorWork(vendorWorkId: string) {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }
  const workOrder = await workOrderRepository.findById(work.workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (workOrder.buildingId !== work.buildingId) {
    throw vendorVerificationBuildingMismatchError();
  }
  return { work, workOrder };
}

/** Resolves the completion / service / BAST context of a Vendor Work. */
async function resolveVendorVerificationContext(
  vendorWorkId: string,
  buildingId: string,
): Promise<VendorVerificationContext> {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }

  const completionReport =
    await vendorCompletionReportRepository.findByVendorWorkId(vendorWorkId);
  const serviceReport =
    await vendorServiceReportRepository.findByVendorWorkId(vendorWorkId);
  const bast = await vendorBastRepository.findByVendorWorkId(vendorWorkId);

  return {
    vendorWorkId: work.id,
    vendorWorkStatus: work.status,
    buildingId,
    completionReport: completionReport
      ? { id: completionReport.id, status: completionReport.completionStatus }
      : null,
    serviceReport: serviceReport
      ? { id: serviceReport.id, status: serviceReport.status }
      : null,
    bast: bast
      ? { id: bast.id, acceptanceStatus: bast.acceptanceStatus }
      : null,
  };
}

/**
 * Resolves the verification state of a Vendor Work: its completion/service/BAST
 * context plus its verification history (reusing the BE-07 reviews table). The
 * latest verification is the most recently reviewed row.
 */
export async function getVendorVerificationState(
  vendorWorkId: string,
  userId: string,
): Promise<VendorVerificationState> {
  const { work, workOrder } = await resolveVendorWork(vendorWorkId);
  await contextAccessService.assertBuildingAccess(userId, workOrder.buildingId);

  const verifications =
    await vendorVerificationRepository.listReviewsByVendorWork(vendorWorkId);
  const latest =
    verifications.length > 0 ? verifications[verifications.length - 1] : null;

  const context = await resolveVendorVerificationContext(
    vendorWorkId,
    workOrder.buildingId,
  );

  return {
    ...context,
    latestVerification: latest,
    verifications,
  };
}

/**
 * Submits a verification decision for a COMPLETED Vendor Work, reusing the
 * BE-07 review primitive. A SUBMITTED Completion Report (when present) is
 * required; an already-APPROVED work cannot be re-verified.
 */
export async function submitVendorVerification(
  input: SubmitVendorVerificationInput,
): Promise<{
  verification: PublicVendorVerification;
  vendorWorkStatus: string;
}> {
  const { work, workOrder } = await resolveVendorWork(input.vendorWorkId);
  await contextAccessService.assertBuildingAccess(
    input.reviewerUserId,
    workOrder.buildingId,
  );

  if (work.status !== 'COMPLETED') {
    throw vendorVerificationInvalidStateError();
  }

  const completionReport =
    await vendorCompletionReportRepository.findByVendorWorkId(work.id);
  if (completionReport && completionReport.completionStatus !== 'SUBMITTED') {
    throw vendorVerificationCompletionNotSubmittedError();
  }

  const latestApproved =
    await vendorVerificationRepository.findLatestApprovedReview(work.id);
  if (latestApproved) {
    throw vendorVerificationAlreadyApprovedError();
  }

  const verification = await vendorVerificationRepository.createReview({
    clientId: workOrder.clientId,
    vendorWorkId: work.id,
    reviewerUserId: input.reviewerUserId,
    decision: input.decision,
    notes: input.notes?.trim() || null,
  });

  await recordOperationalEvent({
    clientId: workOrder.clientId,
    eventType: 'VENDOR_WORK_VERIFIED',
    entityType: 'VENDOR_WORK',
    entityId: work.id,
    actorUserId: input.reviewerUserId,
    buildingId: workOrder.buildingId,
    vendorWorkId: work.id,
    summary: `Vendor work verification decision: ${input.decision}`,
    metadata: {
      decision: input.decision,
      notes: input.notes ?? null,
      reviewId: verification.id,
      workOrderId: workOrder.id,
    },
  });

  // Rework (BE-15J) is not implemented here: REWORK_REQUIRED only records the
  // decision; the Vendor Work's status is deliberately left unchanged.
  return { verification, vendorWorkStatus: work.status };
}

export const vendorVerificationService = {
  getVendorVerificationState,
  submitVendorVerification,
};

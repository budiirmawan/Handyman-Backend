import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import { evaluateWorkOrderBastClosureReadiness } from '../bast-documents';
import { recordWorkOrderEvent } from '../work-order-history';
import {
  workOrderCloseAlreadyClosedError,
  workOrderCloseBastNotReadyError,
  workOrderCloseInvalidStateError,
  workOrderCloseNotApprovedError,
  workOrderVerificationAlreadyApprovedError,
  workOrderVerificationInvalidStateError,
} from './work-order-verification.errors';
import { workOrderVerificationRepository } from './work-order-verification.repository';
import type {
  PublicWorkOrderVerification,
  SubmitWorkOrderVerificationInput,
  WorkOrderVerificationState,
} from './work-order-verification.types';

async function loadWorkOrder(workOrderId: string) {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  return workOrder;
}

/**
 * Resolves the verification state of a Work Order: its current lifecycle
 * status plus its verification history (reusing the BE-07 reviews table). The
 * latest verification is the most recently reviewed row.
 */
export async function getWorkOrderVerificationState(
  workOrderId: string,
): Promise<WorkOrderVerificationState> {
  const workOrder = await loadWorkOrder(workOrderId);
  const verifications =
    await workOrderVerificationRepository.listReviewsByWorkOrder(workOrderId);
  const latest =
    verifications.length > 0 ? verifications[verifications.length - 1] : null;

  return {
    workOrderId: workOrder.id,
    status: workOrder.status,
    latestVerification: latest,
    verifications,
  };
}

/**
 * Submits a verification decision for a COMPLETED Work Order, reusing the
 * BE-07 review primitive.
 *
 * Rules:
 *   - Work Order must be COMPLETED.
 *   - An already-APPROVED Work Order cannot be re-verified (awaiting closure).
 *   - APPROVED / REJECTED leave the Work Order COMPLETED.
 *   - REWORK_REQUIRED moves the Work Order back to IN_PROGRESS (executable),
 *     preserving completion/verification history. It can then execute and
 *     complete again.
 *   - Every submission inserts a fresh review row, so a completed verification
 *     is never silently overwritten.
 */
export async function submitWorkOrderVerification(
  input: SubmitWorkOrderVerificationInput,
): Promise<{
  verification: PublicWorkOrderVerification;
  status: string;
}> {
  const workOrder = await loadWorkOrder(input.workOrderId);

  if (workOrder.status !== 'COMPLETED') {
    throw workOrderVerificationInvalidStateError();
  }

  const latestApproved =
    await workOrderVerificationRepository.findLatestApprovedReview(
      input.workOrderId,
      workOrder.clientId,
    );
  if (latestApproved) {
    throw workOrderVerificationAlreadyApprovedError();
  }

  const verification = await workOrderVerificationRepository.createReview({
    clientId: workOrder.clientId,
    workOrderId: workOrder.id,
    reviewerUserId: input.reviewerUserId,
    decision: input.decision,
    notes: input.notes?.trim() || null,
  });

  if (input.decision === 'REWORK_REQUIRED') {
    // REWORK_REQUIRED returns the Work Order to the executable state; the
    // generic transition table deliberately has no COMPLETED → IN_PROGRESS,
    // so this rework path is the only way back (reusing the BE-08C updateStatus
    // which preserves the original started_at).
    await workOrderRepository.updateStatus(workOrder.id, 'IN_PROGRESS');
    await recordWorkOrderEvent({
      workOrderId: workOrder.id,
      clientId: workOrder.clientId,
      buildingId: workOrder.buildingId,
      eventType: 'WORK_ORDER_REWORK_REQUIRED',
      actorUserId: input.reviewerUserId,
      summary: 'Work order rework required',
      metadata: { decision: 'REWORK_REQUIRED', notes: input.notes ?? null },
    });
    return { verification, status: 'IN_PROGRESS' };
  }

  await recordWorkOrderEvent({
    workOrderId: workOrder.id,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    eventType: 'WORK_ORDER_VERIFIED',
    actorUserId: input.reviewerUserId,
    summary: `Work order verification decision: ${input.decision}`,
    metadata: { decision: input.decision, notes: input.notes ?? null },
  });

  return { verification, status: workOrder.status };
}

/**
 * Returns whether every existing Work Order closure rule, including the
 * configured canonical BE-22 BAST cardinality, currently permits CLOSE.
 * Used by available-actions read models; it never mutates closure state.
 */
export async function canCloseWorkOrder(workOrderId: string): Promise<boolean> {
  const workOrder = await workOrderRepository.findById(workOrderId);
  if (!workOrder || workOrder.status !== 'COMPLETED') return false;

  const latestReview =
    await workOrderVerificationRepository.findLatestCompletedReview(
      workOrder.id,
      workOrder.clientId,
    );
  if (latestReview?.decision !== 'APPROVED') return false;

  return (await evaluateWorkOrderBastClosureReadiness(workOrder)).ready;
}

/**
 * Closes an APPROVED Work Order (COMPLETED → CLOSED). Existing verification
 * rules remain authoritative, then canonical BE-22 readiness gates the same
 * closure mutation. CLOSED remains terminal.
 */
export async function closeWorkOrder(
  workOrderId: string,
): Promise<{ status: string }> {
  const workOrder = await loadWorkOrder(workOrderId);

  if (workOrder.status === 'CLOSED') {
    throw workOrderCloseAlreadyClosedError();
  }
  if (workOrder.status !== 'COMPLETED') {
    throw workOrderCloseInvalidStateError();
  }

  const latestReview =
    await workOrderVerificationRepository.findLatestCompletedReview(
      workOrderId,
      workOrder.clientId,
    );
  if (latestReview?.decision !== 'APPROVED') {
    throw workOrderCloseNotApprovedError();
  }

  const bastReadiness = await evaluateWorkOrderBastClosureReadiness(workOrder);
  if (!bastReadiness.ready) {
    throw workOrderCloseBastNotReadyError(bastReadiness.blockers);
  }

  await workOrderRepository.updateStatus(workOrderId, 'CLOSED');
  await recordWorkOrderEvent({
    workOrderId,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    eventType: 'WORK_ORDER_CLOSED',
    summary: 'Work order closed',
  });
  return { status: 'CLOSED' };
}

export const workOrderVerificationService = {
  canCloseWorkOrder,
  closeWorkOrder,
  getWorkOrderVerificationState,
  submitWorkOrderVerification,
};

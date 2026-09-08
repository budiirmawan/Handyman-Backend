import { contextAccessService } from '../context-access';
import { buildingAccessDeniedError } from '../context-access/context-access.errors';
import { recordOperationalEvent } from '../operational-events';
import { utilityAbnormalConsumptionRepository } from '../utility-abnormal-consumptions';
import type { UtilityAbnormalConsumptionRecord } from '../utility-abnormal-consumptions';
import { utilityMeterConsumptionRepository } from '../utility-meter-consumptions/utility-meter-consumption.repository';
import { utilityMeterRepository } from '../utility-meters/utility-meter.repository';
import {
  utilityVerificationAlreadyCompletedError,
  utilityVerificationAlreadyOpenError,
  utilityVerificationContextInvalidError,
  utilityVerificationContextMismatchError,
  utilityVerificationReviewerMismatchError,
} from './utility-verification.errors';
import {
  toPublicUtilityVerification,
  utilityVerificationRepository,
} from './utility-verification.repository';
import type {
  OpenUtilityVerificationInput,
  PublicUtilityVerification,
  SubmitUtilityVerificationInput,
  UtilityVerificationAction,
  UtilityVerificationContext,
  UtilityVerificationState,
} from './utility-verification.types';

/**
 * BE-18K — Utility Verification service.
 *
 * There is no Utility verification engine here. Verification is the BE-07
 * Review primitive pointed at a BE-18J abnormal consumption: the same
 * `reviews` table, the same PENDING → COMPLETED lifecycle, the same
 * APPROVED / REJECTED / REWORK_REQUIRED vocabulary that Work Order (BE-08I),
 * Finding (BE-09F) and Vendor Work (BE-15I) verification already use. This
 * module only supplies the utility-side context and its access rules.
 *
 * Authorities reused, never re-derived:
 *   - review lifecycle, decisions, verified_at  → BE-07
 *   - abnormality identity, status, tenant snap → BE-18J
 *   - consumption value and period              → BE-18G
 *   - Meter identity, Client / Building, UOM    → BE-18A
 *   - Building access                           → BE-02G
 *   - operational follow-up on the Finding      → BE-09
 *
 * Verification records a judgement about a detection; it does not edit the
 * detection, the consumption or the reading behind it. A REJECTED or
 * REWORK_REQUIRED verdict leaves the abnormality exactly where it was, for
 * BE-18J's own OPEN → RESOLVED / DISMISSED lifecycle to act on.
 *
 * `availableActions` is backend-owned, following BE-09's convention; the
 * client never derives it.
 *
 * Out of scope, deliberately: Tenant Approval Binding (BE-18L).
 */

async function assertBuildingAccess(
  actorUserId: string | undefined,
  buildingId: string,
): Promise<void> {
  if (!actorUserId) {
    return;
  }
  if (!(await contextAccessService.canAccessBuilding(actorUserId, buildingId))) {
    throw buildingAccessDeniedError();
  }
}

function numeric(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Loads the abnormal consumption and re-checks that the utility context hangs
 * together: the detection, its consumption and its meter must agree on
 * Client, Building and Tenant. A detection whose meter has since been moved
 * to another Building is not a context anyone may verify.
 */
async function resolveContext(
  abnormalConsumptionId: string,
): Promise<{
  record: UtilityAbnormalConsumptionRecord;
  context: UtilityVerificationContext;
}> {
  const record = await utilityAbnormalConsumptionRepository.findById(
    abnormalConsumptionId,
  );
  if (!record) {
    throw utilityVerificationContextInvalidError(
      'Abnormal consumption not found.',
    );
  }

  const meter = await utilityMeterRepository.findById(record.meterId);
  if (!meter) {
    throw utilityVerificationContextMismatchError(
      'The meter behind this abnormal consumption no longer exists.',
    );
  }
  if (
    meter.clientId !== record.clientId ||
    meter.buildingId !== record.buildingId
  ) {
    throw utilityVerificationContextMismatchError();
  }

  const consumption = await utilityMeterConsumptionRepository.findById(
    record.consumptionId,
  );
  if (!consumption) {
    throw utilityVerificationContextMismatchError(
      'The consumption behind this abnormal consumption no longer exists.',
    );
  }
  if (
    consumption.meterId !== record.meterId ||
    consumption.clientId !== record.clientId ||
    consumption.buildingId !== record.buildingId
  ) {
    throw utilityVerificationContextMismatchError();
  }
  if ((consumption.tenantCompanyId ?? null) !== (record.tenantCompanyId ?? null)) {
    throw utilityVerificationContextMismatchError(
      'The tenant context of this abnormal consumption does not match its consumption.',
    );
  }

  const context: UtilityVerificationContext = {
    abnormalConsumptionId: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    meterId: record.meterId,
    meterCode: meter.code,
    utilityType: record.utilityType,
    abnormalityType: record.abnormalityType,
    abnormalityStatus: record.status,
    consumptionId: record.consumptionId,
    detectedValue: numeric(record.detectedValue) ?? 0,
    referenceValue: numeric(record.referenceValue),
    thresholdValue: numeric(record.thresholdValue),
    uomId: record.uomId,
    periodStart: record.periodStart.toISOString(),
    periodEnd: record.periodEnd.toISOString(),
    detectedAt: record.detectedAt.toISOString(),
    tenantCompanyId: record.tenantCompanyId,
    tenantAssignmentId: record.tenantAssignmentId,
    findingId: record.findingId,
    reviewable: record.status === 'OPEN',
  };

  return { record, context };
}

function resolveAvailableActions(
  context: UtilityVerificationContext,
  currentReview: PublicUtilityVerification | null,
): UtilityVerificationAction[] {
  if (!context.reviewable) {
    return [];
  }
  return currentReview ? ['SUBMIT_DECISION'] : ['OPEN_REVIEW'];
}

async function buildState(
  context: UtilityVerificationContext,
): Promise<UtilityVerificationState> {
  const records = await utilityVerificationRepository.listByTarget(
    context.abnormalConsumptionId,
  );
  const verifications = records.map(toPublicUtilityVerification);
  const currentReview =
    verifications.find((review) => review.status === 'PENDING') ?? null;
  const completed = verifications.filter(
    (review) => review.status === 'COMPLETED',
  );
  const latestVerification = completed.length
    ? (completed[completed.length - 1] as PublicUtilityVerification)
    : null;

  return {
    ...context,
    currentReview,
    latestVerification,
    verifications,
    availableActions: resolveAvailableActions(context, currentReview),
  };
}

/**
 * GET /utility/abnormal-consumptions/:id/verification — the reviewable
 * context plus its verification state.
 */
export async function getUtilityVerificationContext(
  abnormalConsumptionId: string,
  actorUserId?: string,
): Promise<UtilityVerificationState> {
  const { context } = await resolveContext(abnormalConsumptionId);
  await assertBuildingAccess(actorUserId, context.buildingId);
  return buildState(context);
}

/**
 * POST /utility/abnormal-consumptions/:id/verification/open — opens a PENDING
 * BE-07 review naming the reviewer of record.
 */
export async function openUtilityVerification(
  input: OpenUtilityVerificationInput,
  actorUserId?: string,
): Promise<UtilityVerificationState> {
  const { context } = await resolveContext(input.abnormalConsumptionId);
  await assertBuildingAccess(actorUserId, context.buildingId);

  if (!context.reviewable) {
    throw utilityVerificationContextInvalidError(
      `This abnormal consumption is ${context.abnormalityStatus.toLowerCase()} and can no longer be verified.`,
    );
  }

  // The reviewer of record must themselves hold access to the Building.
  await assertBuildingAccess(input.reviewerUserId, context.buildingId);

  const existing = await utilityVerificationRepository.findPendingByTarget(
    context.abnormalConsumptionId,
  );
  if (existing) {
    throw utilityVerificationAlreadyOpenError();
  }

  try {
    await utilityVerificationRepository.createPending({
      clientId: context.clientId,
      abnormalConsumptionId: context.abnormalConsumptionId,
      reviewerUserId: input.reviewerUserId,
      notes: input.notes ?? null,
    });
  } catch (error) {
    // The partial unique index is the real guard against a concurrent open.
    if ((error as { code?: string }).code === '23505') {
      throw utilityVerificationAlreadyOpenError();
    }
    throw error;
  }

  await recordOperationalEvent({
    clientId: context.clientId,
    eventType: 'UTILITY_VERIFICATION_OPENED',
    entityType: 'UTILITY_ABNORMAL_CONSUMPTION',
    entityId: context.abnormalConsumptionId,
    ...(actorUserId ? { actorUserId } : {}),
    buildingId: context.buildingId,
    summary: `Verification opened for ${context.abnormalityType} on meter ${context.meterCode}`,
    metadata: {
      meterId: context.meterId,
      consumptionId: context.consumptionId,
      abnormalityType: context.abnormalityType,
      reviewerUserId: input.reviewerUserId,
    },
  });

  return buildState(context);
}

/**
 * POST /utility/abnormal-consumptions/:id/verification — records the reviewer's
 * decision against the open BE-07 review.
 *
 * The completion is SQL-guarded on `status = 'PENDING'`, so a decision that
 * has already been recorded is never silently replaced — the caller is told
 * it is final and the earlier verdict stands.
 */
export async function submitUtilityVerification(
  input: SubmitUtilityVerificationInput,
  actorUserId?: string,
): Promise<UtilityVerificationState> {
  const { context } = await resolveContext(input.abnormalConsumptionId);
  await assertBuildingAccess(actorUserId, context.buildingId);

  if (!context.reviewable) {
    throw utilityVerificationContextInvalidError(
      `This abnormal consumption is ${context.abnormalityStatus.toLowerCase()} and can no longer be verified.`,
    );
  }

  const pending = await utilityVerificationRepository.findPendingByTarget(
    context.abnormalConsumptionId,
  );
  if (!pending) {
    const history = await utilityVerificationRepository.listByTarget(
      context.abnormalConsumptionId,
    );
    if (history.length > 0) {
      throw utilityVerificationAlreadyCompletedError();
    }
    throw utilityVerificationContextInvalidError(
      'No verification is open for this abnormal consumption.',
    );
  }

  // Only the reviewer the review was opened for may decide it.
  if (pending.reviewerUserId !== input.reviewerUserId) {
    throw utilityVerificationReviewerMismatchError();
  }

  const completed = await utilityVerificationRepository.complete(
    pending.id,
    input.decision,
    input.notes ?? pending.notes,
  );
  if (!completed) {
    throw utilityVerificationAlreadyCompletedError();
  }

  await recordOperationalEvent({
    clientId: context.clientId,
    eventType: 'UTILITY_VERIFICATION_COMPLETED',
    entityType: 'UTILITY_ABNORMAL_CONSUMPTION',
    entityId: context.abnormalConsumptionId,
    ...(actorUserId ? { actorUserId } : {}),
    buildingId: context.buildingId,
    summary: `Verification ${input.decision} for ${context.abnormalityType} on meter ${context.meterCode}`,
    metadata: {
      meterId: context.meterId,
      consumptionId: context.consumptionId,
      abnormalityType: context.abnormalityType,
      decision: input.decision,
      reviewerUserId: input.reviewerUserId,
      reviewId: completed.id,
    },
  });

  // The abnormality's own status is BE-18J's to change, not ours.
  return buildState(context);
}

/**
 * GET /utility/abnormal-consumptions/:id/verification/latest — the most recent
 * COMPLETED verification result, or null when none exists yet.
 */
export async function getLatestUtilityVerification(
  abnormalConsumptionId: string,
  actorUserId?: string,
): Promise<PublicUtilityVerification | null> {
  const { context } = await resolveContext(abnormalConsumptionId);
  await assertBuildingAccess(actorUserId, context.buildingId);

  const state = await buildState(context);
  return state.latestVerification;
}

/**
 * GET /utility/abnormal-consumptions/:id/verifications — the full verification
 * history, oldest first. Append-oriented: nothing is ever removed.
 */
export async function listUtilityVerifications(
  abnormalConsumptionId: string,
  actorUserId?: string,
): Promise<PublicUtilityVerification[]> {
  const { context } = await resolveContext(abnormalConsumptionId);
  await assertBuildingAccess(actorUserId, context.buildingId);

  const records = await utilityVerificationRepository.listByTarget(
    abnormalConsumptionId,
  );
  return records.map(toPublicUtilityVerification);
}

export const utilityVerificationService = {
  getLatestUtilityVerification,
  getUtilityVerificationContext,
  listUtilityVerifications,
  openUtilityVerification,
  submitUtilityVerification,
};

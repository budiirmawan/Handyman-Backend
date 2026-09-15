import { getPool } from '../../database';
import { AppError, ERROR_CODES } from '../../shared/errors';
import { buildingAccessDeniedError, contextAccessService } from '../context-access';
import { permissionService } from '../permissions';
import { reviewService, type PublicReview } from '../reviews';
import { resolveBoundFormInstanceBuilding } from '../form-instances';
import { REVIEW_DECISIONS, type ReviewDecision } from '../reviews';
import {
  findingReviewService,
  findingReviewImmutableError,
  openFindingReview,
  submitFindingVerification,
} from '../finding-reviews';
import { findingService } from '../findings';
import { resolveFindingActionAuthority } from '../findings/finding-action.authority';
import { userRepository } from '../users';
import { workOrderService } from '../work-orders';
import {
  getWorkOrderVerificationState,
  submitWorkOrderVerification,
} from '../work-order-verification';
import { workforceRepository } from '../workforce/workforce.repository';
import type { PublicWorkOrder } from '../work-orders';
import type {
  MobileVerificationContract,
  MobileVerificationResourceReference,
  MobileVerificationReviewer,
  MobileVerificationState,
  MobileVerificationTargetType,
} from './mobile-verification.types';

/**
 * BE-25J — Mobile supervisor verification service.
 *
 * Thin composition over the existing authorities — no separate mobile
 * verification engine:
 *   - REVIEW targets (CHECKLIST_EXECUTION / FORM_INSTANCE / WORK_ORDER) —
 *     the shared `reviews` table via `reviewService` (the same service the
 *     review endpoints use); WORK_ORDER delegates to the BE-08I
 *     verification services (`getWorkOrderVerificationState` /
 *     `submitWorkOrderVerification`), so the mobile surface and the Web
 *     surface execute the exact same lifecycle (COMPLETED-only, APPROVED
 *     immutable, REWORK_REQUIRED → IN_PROGRESS),
 *   - FINDING — the BE-09 finding verification services
 *     (`findingReviewService`, `submitFindingVerification`) and the BE-09
 *     action authority (`resolveFindingActionAuthority`).
 *
 * Supervisor authorization: per-target-type RBAC (review.manage for REVIEW
 * targets, work_order.manage for WORK_ORDER, finding.review for FINDING)
 * enforced here — the same permissions the existing Web endpoints require.
 * Completed verifications are immutable (never silently overwritten).
 * Client/Building isolation is preserved with the same BE-02G assertions the
 * Web endpoints use.
 */

const FINDING_VERIFICATION_ACTIONS = [
  'OPEN_REVIEW',
  'APPROVE',
  'REJECT',
  'REQUEST_REWORK',
] as const;

const READ_PERMISSION: Record<MobileVerificationTargetType, string> = {
  CHECKLIST_EXECUTION: 'review.read',
  FORM_INSTANCE: 'review.read',
  FINDING: 'finding.read',
  WORK_ORDER: 'work_order.read',
};

const WRITE_PERMISSION: Record<MobileVerificationTargetType, string> = {
  CHECKLIST_EXECUTION: 'review.manage',
  FORM_INSTANCE: 'review.manage',
  FINDING: 'finding.review',
  WORK_ORDER: 'work_order.manage',
};

function permissionDeniedError(): AppError {
  return new AppError({
    code: ERROR_CODES.PERMISSION_DENIED,
    message: 'You do not have permission to perform this action.',
    statusCode: 403,
  });
}

async function assertPermission(
  userId: string,
  permission: string,
): Promise<void> {
  const permissions = await permissionService.resolvePermissionsForUser(userId);
  if (!permissions.includes(permission)) {
    throw permissionDeniedError();
  }
}

async function resolveReviewer(
  reviewerUserId: string | null,
): Promise<MobileVerificationReviewer | null> {
  if (!reviewerUserId) {
    return null;
  }
  const [user, profile] = await Promise.all([
    userRepository.findById(reviewerUserId),
    workforceRepository.findByUserId(reviewerUserId),
  ]);
  return {
    userId: reviewerUserId,
    displayName: user?.displayName ?? 'Unknown reviewer',
    workforceProfileId: profile?.id ?? null,
    fullName: profile?.fullName ?? null,
    employeeCode: profile?.employeeCode ?? null,
  };
}

// ---------------------------------------------------------------------------
// REVIEW targets (CHECKLIST_EXECUTION / FORM_INSTANCE)
// ---------------------------------------------------------------------------

async function loadReviewTargetResource(
  targetType: 'CHECKLIST_EXECUTION' | 'FORM_INSTANCE',
  targetId: string,
  userId: string,
): Promise<{
  status: string;
  client_id: string;
  building_id: string | null;
  reference: MobileVerificationResourceReference;
}> {
  const result = await getPool().query<{
    id: string;
    client_id: string;
    status: string;
    started_at: Date | null;
    completed_at: Date | null;
    form_template_version_id?: string;
    generated_task_id?: string | null;
  }>(
    targetType === 'FORM_INSTANCE'
      ? `SELECT id, client_id, status, started_at, completed_at,
                form_template_version_id, generated_task_id
           FROM form_instances WHERE id = $1`
      : `SELECT id, client_id, status, started_at, completed_at
           FROM checklist_executions WHERE id = $1`,
    [targetId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError({
      code: ERROR_CODES.NOT_FOUND,
      message: 'Review target not found.',
      statusCode: 404,
      resource: { type: targetType, id: targetId },
    });
  }
  const clientIds = await contextAccessService.getAccessibleClientIds(userId);
  if (!clientIds.includes(row.client_id)) {
    throw buildingAccessDeniedError();
  }

  let buildingId: string | null = null;
  if (targetType === 'FORM_INSTANCE') {
    buildingId = await resolveBoundFormInstanceBuilding({
      client_id: row.client_id,
      form_template_version_id: row.form_template_version_id as string,
      generated_task_id: row.generated_task_id,
    });
    if (buildingId) {
      const buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
      if (!buildingIds.includes(buildingId)) {
        throw buildingAccessDeniedError();
      }
    }
  }

  let reference: MobileVerificationResourceReference = {
    status: row.status,
    checklist: null,
    form: null,
    finding: null,
    workOrder: null,
  };

  if (targetType === 'CHECKLIST_EXECUTION') {
    const template = await getPool().query<{ id: string; code: string; name: string }>(
      `SELECT ct.id, ct.code, ct.name
         FROM checklist_templates ct
         JOIN checklist_executions ce ON ce.checklist_template_id = ct.id
        WHERE ce.id = $1`,
      [targetId],
    );
    reference = {
      status: row.status,
      checklist: template.rows[0] ?? null,
      form: null,
      finding: null,
      workOrder: null,
    };
  } else {
    const form = await getPool().query<{ id: string; code: string; name: string }>(
      `SELECT ft.id, ft.code, ft.name
         FROM form_templates ft
         JOIN form_template_versions ftv ON ftv.form_template_id = ft.id
         JOIN form_instances fi ON fi.form_template_version_id = ftv.id
        WHERE fi.id = $1`,
      [targetId],
    );
    reference = {
      status: row.status,
      checklist: null,
      form: form.rows[0] ?? null,
      finding: null,
      workOrder: null,
    };
  }

  return {
    status: row.status,
    client_id: row.client_id,
    building_id: buildingId,
    reference,
  };
}

function reviewState(
  resourceStatus: string,
  reviews: PublicReview[],
): { state: string; review: PublicReview | null } {
  const pending = reviews.find((review) => review.status === 'PENDING') ?? null;
  const completed =
    reviews.find((review) => review.status === 'COMPLETED') ?? null;

  if (resourceStatus !== 'COMPLETED') {
    return { state: 'NOT_REVIEWABLE', review: pending ?? completed };
  }
  if (completed) {
    const state =
      completed.decision === 'APPROVED'
        ? 'VERIFIED'
        : completed.decision === 'REJECTED'
          ? 'REJECTED'
          : 'REWORK_REQUIRED';
    return { state, review: completed };
  }
  return { state: 'PENDING', review: pending };
}

function buildReviewTargetContract(
  targetType: 'CHECKLIST_EXECUTION' | 'FORM_INSTANCE',
  targetId: string,
  resource: {
    status: string;
    client_id: string;
    building_id: string | null;
    reference: MobileVerificationResourceReference;
  },
  reviews: PublicReview[],
  reviewer: MobileVerificationReviewer | null,
): MobileVerificationContract {
  const { state, review } = reviewState(resource.status, reviews);
  const hasCompleted = reviews.some((entry) => entry.status === 'COMPLETED');
  const availableActions =
    resource.status === 'COMPLETED' && !hasCompleted ? ['SUBMIT_DECISION'] : [];

  return {
    targetType,
    targetId,
    clientId: resource.client_id,
    buildingId: resource.building_id,
    resource: resource.reference,
    verification: {
      state,
      decision: review?.decision ?? null,
      notes: review?.notes ?? null,
      verifiedAt: review?.reviewedAt ?? null,
      reviewId: review?.id ?? null,
      reviewStatus: review?.status ?? null,
    },
    reviewer,
    availableActions,
    updatedAt: review?.updatedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// FINDING target
// ---------------------------------------------------------------------------

async function buildFindingContract(
  findingId: string,
  userId: string,
): Promise<MobileVerificationContract> {
  const finding = await findingService.getFindingById(findingId);
  await contextAccessService.assertBuildingAccess(userId, finding.buildingId);

  const [verification, authority] = await Promise.all([
    findingReviewService.getFindingVerificationState(findingId),
    resolveFindingActionAuthority(findingId, userId),
  ]);

  const review =
    verification.currentReview ?? verification.latestVerification ?? null;
  const reviewer = await resolveReviewer(review?.reviewerUserId ?? null);

  const availableActions = FINDING_VERIFICATION_ACTIONS.filter((action) =>
    authority.isAllowed(action),
  );

  return {
    targetType: 'FINDING',
    targetId: findingId,
    clientId: finding.clientId,
    buildingId: finding.buildingId,
    resource: {
      status: finding.status,
      checklist: null,
      form: null,
      finding: {
        id: finding.id,
        findingNumber: finding.findingNumber,
        title: finding.title,
        status: finding.status,
        reportedAt: finding.reportedAt,
      },
      workOrder: null,
    },
    verification: {
      state: verification.state,
      decision: review?.decision ?? null,
      notes: review?.notes ?? null,
      verifiedAt: review?.reviewedAt ?? null,
      reviewId: review?.id ?? null,
      reviewStatus: review?.status ?? null,
    },
    reviewer,
    availableActions,
    updatedAt: review?.updatedAt ?? finding.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// WORK_ORDER target (BE-08I verification lifecycle, composed — no new engine)
// ---------------------------------------------------------------------------

/**
 * The mobile verification contract for a WORK_ORDER target. The Work Order
 * is resolved by its authoritative `work_orders.id` (unknown id → 404) and
 * Building access is asserted on its `buildingId` (BE-02G) — the exact
 * isolation the Web verification endpoints enforce. The verification state
 * and submission delegate to the BE-08I services
 * (`getWorkOrderVerificationState` / `submitWorkOrderVerification`), so the
 * mobile surface and the Web surface share one lifecycle:
 *   - NOT_REVIEWABLE  — Work Order not COMPLETED,
 *   - PENDING         — COMPLETED, awaiting a decision,
 *   - VERIFIED / REJECTED / REWORK_REQUIRED — completed decision state
 *     (REWORK_REQUIRED also moves the Work Order back to IN_PROGRESS, as
 *     the BE-08I service does — this contract only reflects it).
 * `availableActions` is `['SUBMIT_DECISION']` when the Work Order is
 * COMPLETED and no completed verification exists; the BE-08I service still
 * rejects an already-APPROVED Work Order (immutable).
 */
async function buildWorkOrderContract(
  workOrderId: string,
  userId: string,
): Promise<MobileVerificationContract> {
  const workOrder: PublicWorkOrder = await workOrderService.getWorkOrderById(
    workOrderId,
  );
  await contextAccessService.assertBuildingAccess(userId, workOrder.buildingId);

  const state = await getWorkOrderVerificationState(workOrderId);
  const latest = state.latestVerification;
  const reviewer = await resolveReviewer(latest?.reviewerUserId ?? null);

  let verificationState: string;
  if (workOrder.status !== 'COMPLETED') {
    verificationState = 'NOT_REVIEWABLE';
  } else if (latest) {
    verificationState =
      latest.decision === 'APPROVED'
        ? 'VERIFIED'
        : latest.decision === 'REJECTED'
          ? 'REJECTED'
          : 'REWORK_REQUIRED';
  } else {
    verificationState = 'PENDING';
  }

  const hasCompleted = state.verifications.some(
    (entry) => entry.status === 'COMPLETED',
  );
  const availableActions =
    workOrder.status === 'COMPLETED' && !hasCompleted
      ? ['SUBMIT_DECISION']
      : [];

  return {
    targetType: 'WORK_ORDER',
    targetId: workOrderId,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
    resource: {
      status: workOrder.status,
      checklist: null,
      form: null,
      finding: null,
      workOrder: {
        id: workOrder.id,
        workOrderNumber: workOrder.workOrderNumber,
        title: workOrder.title,
        status: workOrder.status,
      },
    },
    verification: {
      state: verificationState,
      decision: latest?.decision ?? null,
      notes: latest?.notes ?? null,
      verifiedAt: latest?.reviewedAt ?? null,
      reviewId: latest?.id ?? null,
      reviewStatus: latest?.status ?? null,
    },
    reviewer,
    availableActions,
    updatedAt: latest?.reviewedAt ?? workOrder.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getMobileVerification(
  targetType: string,
  targetId: string,
  userId: string,
): Promise<MobileVerificationContract> {
  if (targetType === 'FINDING') {
    await assertPermission(userId, READ_PERMISSION.FINDING);
    return buildFindingContract(targetId, userId);
  }
  if (targetType === 'WORK_ORDER') {
    await assertPermission(userId, READ_PERMISSION.WORK_ORDER);
    return buildWorkOrderContract(targetId, userId);
  }
  if (targetType === 'CHECKLIST_EXECUTION' || targetType === 'FORM_INSTANCE') {
    await assertPermission(userId, READ_PERMISSION[targetType]);
    const resource = await loadReviewTargetResource(targetType, targetId, userId);
    const reviews = await reviewService.listReviewsByTarget(targetType, targetId, userId);
    const pending = reviews.find((entry) => entry.status === 'PENDING') ?? null;
    const completed = reviews.find((entry) => entry.status === 'COMPLETED') ?? null;
    const reviewer = await resolveReviewer(
      (pending ?? completed)?.reviewerUserId ?? null,
    );
    return buildReviewTargetContract(targetType, targetId, resource, reviews, reviewer);
  }
  throw AppError.validation('Request validation failed.', [
    {
      field: 'targetType',
      message:
        'targetType must be CHECKLIST_EXECUTION, FORM_INSTANCE, FINDING or WORK_ORDER.',
    },
  ]);
}

export type SubmitVerificationInput = {
  decision: ReviewDecision;
  notes?: string;
};

export async function submitMobileVerification(
  targetType: string,
  targetId: string,
  userId: string,
  input: SubmitVerificationInput,
): Promise<MobileVerificationContract> {
  if (!REVIEW_DECISIONS.includes(input.decision)) {
    throw AppError.validation('Request validation failed.', [
      {
        field: 'decision',
        message: `decision must be one of: ${REVIEW_DECISIONS.join(', ')}.`,
      },
    ]);
  }

  if (targetType === 'FINDING') {
    await assertPermission(userId, WRITE_PERMISSION.FINDING);
    const action =
      input.decision === 'APPROVED'
        ? 'APPROVE'
        : input.decision === 'REJECTED'
          ? 'REJECT'
          : 'REQUEST_REWORK';
    const finding = await findingService.getFindingById(targetId);
    await contextAccessService.assertBuildingAccess(userId, finding.buildingId);

    // Mirror the Web flow: when no review is open, the first step is the
    // OPEN_REVIEW action (same authority as POST /findings/:id/reviews).
    const verification = await findingReviewService.getFindingVerificationState(targetId);
    if (!verification.currentReview) {
      const openAuthority = await resolveFindingActionAuthority(targetId, userId);
      if (!openAuthority.isAllowed('OPEN_REVIEW')) {
        throw new AppError({
          code: ERROR_CODES.FINDING_ACTION_NOT_ALLOWED,
          message: 'Finding action OPEN_REVIEW is not allowed.',
          statusCode: 403,
        });
      }
      if (verification.reviews.some((review) => review.status === 'COMPLETED')) {
        throw findingReviewImmutableError();
      }
      try {
        await openFindingReview({ findingId: targetId, reviewerUserId: userId });
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === 'FINDING_REVIEW_ALREADY_OPEN'
        ) {
          // Concurrent open — proceed; the decision authority below still
          // enforces the reviewer match.
        } else {
          throw error;
        }
      }
    }

    // After the review is open, check the DECISION action authority — the
    // same check the Web verification endpoint performs (reviewer match is
    // part of the authority).
    const decisionAuthority = await resolveFindingActionAuthority(targetId, userId);
    if (!decisionAuthority.isAllowed(action)) {
      throw new AppError({
        code: ERROR_CODES.FINDING_ACTION_NOT_ALLOWED,
        message: `Finding action ${action} is not allowed.`,
        statusCode: 403,
      });
    }

    await submitFindingVerification({
      findingId: targetId,
      reviewerUserId: userId,
      decision: input.decision,
      notes: input.notes,
    });
    return buildFindingContract(targetId, userId);
  }

  if (targetType === 'WORK_ORDER') {
    await assertPermission(userId, WRITE_PERMISSION.WORK_ORDER);
    // Resolve the Work Order by its authoritative id and enforce BE-02G
    // isolation first — the same checks the Web verification endpoint
    // performs (unknown id → 404; inaccessible → 403).
    const workOrder = await workOrderService.getWorkOrderById(targetId);
    await contextAccessService.assertBuildingAccess(userId, workOrder.buildingId);

    // Delegate to the EXISTING BE-08I verification service — no duplicate
    // logic: COMPLETED-only, already-APPROVED immutable, REWORK_REQUIRED
    // moves the Work Order back to IN_PROGRESS, fresh review row per
    // submission (completed verifications are never overwritten).
    await submitWorkOrderVerification({
      workOrderId: targetId,
      reviewerUserId: userId,
      decision: input.decision,
      notes: input.notes,
    });
    return buildWorkOrderContract(targetId, userId);
  }

  if (targetType === 'CHECKLIST_EXECUTION' || targetType === 'FORM_INSTANCE') {
    await assertPermission(userId, WRITE_PERMISSION[targetType]);
    const resource = await loadReviewTargetResource(targetType, targetId, userId);
    // Reviewable targets must be COMPLETED (same rule as the review endpoints).
    if (resource.status !== 'COMPLETED') {
      throw AppError.badRequest('Review target is not completed.');
    }

    const reviews = await reviewService.listReviewsByTarget(targetType, targetId, userId);
    const pending = reviews.find((entry) => entry.status === 'PENDING') ?? null;
    const completed = reviews.find((entry) => entry.status === 'COMPLETED') ?? null;
    if (completed && !pending) {
      // BE-25K conflict metadata: the current immutable verification state
      // plus reload guidance, so mobile can recover without a blind retry.
      const reviewer = await resolveReviewer(completed.reviewerUserId);
      const current = buildReviewTargetContract(
        targetType,
        targetId,
        resource,
        reviews,
        reviewer,
      );
      throw new AppError({
        code: ERROR_CODES.BAD_REQUEST,
        message: 'Completed review cannot be overwritten.',
        statusCode: 400,
        resource: { type: targetType, id: targetId },
        conflict: {
          current,
          guidance: {
            action: 'reload',
            reloadEndpoint: `/mobile/verification/${targetType}/${targetId}`,
            message:
              'The verification is already completed. Reload the current verification state.',
          },
        },
      });
    }

    if (pending) {
      await reviewService.decideReview(pending.id, userId, input.decision, input.notes);
    } else {
      const created = await reviewService.createReview(
        targetType,
        targetId,
        userId,
        input.notes,
      );
      await reviewService.decideReview(created.id, userId, input.decision, input.notes);
    }

    const freshReviews = await reviewService.listReviewsByTarget(targetType, targetId, userId);
    const freshCompleted = freshReviews.find((entry) => entry.status === 'COMPLETED') ?? null;
    const reviewer = await resolveReviewer(freshCompleted?.reviewerUserId ?? null);
    return buildReviewTargetContract(targetType, targetId, resource, freshReviews, reviewer);
  }

  throw AppError.validation('Request validation failed.', [
    {
      field: 'targetType',
      message:
        'targetType must be CHECKLIST_EXECUTION, FORM_INSTANCE, FINDING or WORK_ORDER.',
    },
  ]);
}

export const mobileVerificationService = {
  getMobileVerification,
  submitMobileVerification,
};

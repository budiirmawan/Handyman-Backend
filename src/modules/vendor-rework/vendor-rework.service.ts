import { contextAccessService } from '../context-access';
import { recordOperationalEvent } from '../operational-events';
import { vendorVerificationRepository } from '../vendor-verification';
import {
  vendorWorkNotFoundError,
  vendorWorkRepository,
} from '../vendor-work';
import {
  workOrderNotFoundError,
  workOrderRepository,
} from '../work-orders';
import {
  vendorReworkAlreadyOpenError,
  vendorReworkBuildingMismatchError,
  vendorReworkImmutableError,
  vendorReworkInvalidVerificationError,
  vendorReworkNotFoundError,
  vendorReworkReviewConsumedError,
} from './vendor-rework.errors';
import { vendorReworkRepository } from './vendor-rework.repository';
import type {
  PublicVendorRework,
  VendorReworkContext,
  VendorReworkRecord,
} from './vendor-rework.types';

/**
 * BE-15J — Vendor Work Rework service.
 *
 * Reuses BE-09's Reject / Rework / Resubmission behavior: a rework cycle is
 * always anchored to a REWORK_REQUIRED verification (BE-15I) and preserves
 * every cycle — resubmission never overwrites previous cycles. No separate
 * Vendor rework engine is created. Rework is deliberately bookkeeping-only:
 * it never mutates the Vendor Work's status, and previous completion / report
 * / BAST / verification history is preserved untouched.
 */

export function toPublicVendorRework(row: VendorReworkRecord): PublicVendorRework {
  return {
    ...row,
    requestedAt: row.requestedAt.toISOString(),
    resubmittedAt: row.resubmittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Resolves the Vendor Work and its authoritative Building context from the
 * BE-08 Work Order (the authority for the Work Order's Building).
 */
async function resolveVendorWork(vendorWorkId: string): Promise<{
  vendorWorkId: string;
  vendorWorkStatus: string;
  buildingId: string;
  clientId: string;
}> {
  const work = await vendorWorkRepository.findById(vendorWorkId);
  if (!work) {
    throw vendorWorkNotFoundError();
  }
  const workOrder = await workOrderRepository.findById(work.workOrderId);
  if (!workOrder) {
    throw workOrderNotFoundError();
  }
  if (workOrder.buildingId !== work.buildingId) {
    throw vendorReworkBuildingMismatchError();
  }
  return {
    vendorWorkId: work.id,
    vendorWorkStatus: work.status,
    buildingId: workOrder.buildingId,
    clientId: workOrder.clientId,
  };
}

function isCurrentUnique(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string } | null;
  return (
    value?.code === '23505' &&
    value.constraint === 'vendor_current_rework_unique'
  );
}

function isReviewUnique(error: unknown): boolean {
  const value = error as { code?: string; constraint?: string } | null;
  return (
    value?.code === '23505' &&
    value.constraint === 'vendor_rework_review_unique'
  );
}

/**
 * Requests rework for a Vendor Work. The latest verification must be a
 * REWORK_REQUIRED decision (BE-15I), and no current (REQUESTED) cycle may
 * already exist. The new cycle references that verification review.
 */
export async function requestVendorRework(input: {
  vendorWorkId: string;
  userId: string;
  reason: string;
}): Promise<{ rework: PublicVendorRework }> {
  const context = await resolveVendorWork(input.vendorWorkId);
  await contextAccessService.assertBuildingAccess(input.userId, context.buildingId);

  const verifications =
    await vendorVerificationRepository.listReviewsByVendorWork(
      input.vendorWorkId,
    );
  const latest = verifications[verifications.length - 1];
  if (!latest || latest.decision !== 'REWORK_REQUIRED') {
    throw vendorReworkInvalidVerificationError();
  }

  const current = await vendorReworkRepository.findCurrent(input.vendorWorkId);
  if (current) {
    throw vendorReworkAlreadyOpenError();
  }

  try {
    const cycle = await vendorReworkRepository.create({
      vendorWorkId: input.vendorWorkId,
      reviewId: latest.id,
      requestedByUserId: input.userId,
      reason: input.reason,
    });
    await recordOperationalEvent({
      clientId: context.clientId,
      eventType: 'VENDOR_WORK_REWORK_REQUESTED',
      entityType: 'VENDOR_WORK',
      entityId: input.vendorWorkId,
      actorUserId: input.userId,
      buildingId: context.buildingId,
      vendorWorkId: input.vendorWorkId,
      summary: 'Vendor work rework requested',
      metadata: { reviewId: latest.id, reworkCycleId: cycle.id },
    });
    return { rework: toPublicVendorRework(cycle) };
  } catch (error) {
    if (isCurrentUnique(error)) throw vendorReworkAlreadyOpenError();
    if (isReviewUnique(error)) throw vendorReworkReviewConsumedError();
    throw error;
  }
}

/** Resolves the current rework context of a Vendor Work (current + cycles). */
export async function getVendorReworkContext(
  vendorWorkId: string,
  userId: string,
): Promise<VendorReworkContext> {
  const context = await resolveVendorWork(vendorWorkId);
  await contextAccessService.assertBuildingAccess(userId, context.buildingId);

  const cycles = (
    await vendorReworkRepository.listByVendorWorkId(vendorWorkId)
  ).map(toPublicVendorRework);

  return {
    vendorWorkId: context.vendorWorkId,
    vendorWorkStatus: context.vendorWorkStatus,
    buildingId: context.buildingId,
    current:
      [...cycles].reverse().find((cycle) => cycle.status === 'REQUESTED') ??
      null,
    cycles,
  };
}

/** Updates the rework notes of the current (REQUESTED) cycle. */
export async function updateVendorReworkNotes(input: {
  vendorWorkId: string;
  userId: string;
  notes: string;
}): Promise<PublicVendorRework> {
  const context = await resolveVendorWork(input.vendorWorkId);
  await contextAccessService.assertBuildingAccess(input.userId, context.buildingId);

  const cycle = await vendorReworkRepository.findCurrent(input.vendorWorkId);
  if (!cycle) {
    throw vendorReworkNotFoundError();
  }

  const updated = await vendorReworkRepository.updateNotes(cycle.id, input.notes);
  if (!updated) {
    throw vendorReworkImmutableError();
  }

  await recordOperationalEvent({
    clientId: context.clientId,
    eventType: 'VENDOR_WORK_REWORK_NOTES_UPDATED',
    entityType: 'VENDOR_WORK',
    entityId: input.vendorWorkId,
    actorUserId: input.userId,
    buildingId: context.buildingId,
    vendorWorkId: input.vendorWorkId,
    summary: 'Vendor work rework notes updated',
    metadata: { reworkCycleId: cycle.id },
  });
  return toPublicVendorRework(updated);
}

/**
 * Resubmits a Vendor Work rework: the current (REQUESTED) cycle is marked
 * RESUBMITTED with the resubmitting actor and timestamp. Previous cycles are
 * preserved untouched, and the Vendor Work's completion history is unchanged.
 */
export async function resubmitVendorWork(input: {
  vendorWorkId: string;
  userId: string;
  notes: string;
}): Promise<{ rework: PublicVendorRework }> {
  const context = await resolveVendorWork(input.vendorWorkId);
  await contextAccessService.assertBuildingAccess(input.userId, context.buildingId);

  const cycle = await vendorReworkRepository.findCurrent(input.vendorWorkId);
  if (!cycle) {
    throw vendorReworkNotFoundError();
  }

  const updated = await vendorReworkRepository.markResubmitted(
    cycle.id,
    input.userId,
    input.notes,
  );
  if (!updated) {
    throw vendorReworkImmutableError();
  }

  await recordOperationalEvent({
    clientId: context.clientId,
    eventType: 'VENDOR_WORK_RESUBMITTED',
    entityType: 'VENDOR_WORK',
    entityId: input.vendorWorkId,
    actorUserId: input.userId,
    buildingId: context.buildingId,
    vendorWorkId: input.vendorWorkId,
    summary: 'Vendor work resubmitted',
    metadata: { reworkCycleId: cycle.id },
  });
  return { rework: toPublicVendorRework(updated) };
}

export const vendorReworkService = {
  getVendorReworkContext,
  requestVendorRework,
  resubmitVendorWork,
  toPublicVendorRework,
  updateVendorReworkNotes,
};

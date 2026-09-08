import { contextAccessService } from '../context-access';
import { contractorVisitorCancelledCheckInError } from '../contractor-visitors/contractor-visitor.errors';
import { contractorVisitorRepository } from '../contractor-visitors/contractor-visitor.repository';
import { deliveryCourierNotActiveForCheckInError } from '../delivery-couriers/delivery-courier.errors';
import { deliveryCourierRepository } from '../delivery-couriers/delivery-courier.repository';
import { visitorRepository } from '../visitors';
import {
  expectedVisitorNotFoundError,
  expectedVisitorRepository,
} from '../expected-visitors';
import type { ExpectedVisitorRecord } from '../expected-visitors';
import {
  walkInVisitNotFoundError,
  walkInVisitRepository,
} from '../walk-in-visits';
import type { WalkInVisitRecord } from '../walk-in-visits';
import { hostConfirmationRepository } from '../host-confirmations';
import { visitorPassActiveAtVisitClosureError } from '../visitor-passes/visitor-pass.errors';
import { visitorPassRepository } from '../visitor-passes/visitor-pass.repository';
import {
  visitCheckInAlreadyCancelledError,
  visitCheckInAlreadyCheckedInError,
  visitCheckInConfirmationPendingError,
  visitCheckInConfirmationRejectedError,
  visitCheckInNotFoundError,
  visitCheckInTimeInFutureError,
  visitCheckInVisitCancelledError,
  visitCheckInVisitorNotActiveError,
  visitCheckInVisitReferenceRequiredError,
  visitCheckOutAlreadyCheckedOutError,
  visitCheckOutBeforeCheckInError,
  visitCheckOutNotActiveError,
  visitCheckOutTimeInFutureError,
} from './visit-check-in.errors';
import { visitCheckInRepository } from './visit-check-in.repository';
import type {
  CheckOutVisitInput,
  CreateVisitCheckInInput,
  PublicVisitCheckIn,
  VisitCheckInListFilters,
  VisitCheckInRecord,
} from './visit-check-in.types';

/**
 * BE-13G — Check-In service.
 *
 * Backend-authoritative check-in over the existing BE-13 visit
 * contexts (Expected Visitor / Walk-In). Building, Client and visitor
 * identity all derive from the visit row — never caller-supplied, so
 * the check-in can never land in the wrong Building context.
 *
 * Validation order (pinned by tests):
 *   1. exactly one visit reference          → 400
 *   2. unknown visit                        → 404
 *   3. inaccessible Building                → 403 BUILDING_ACCESS_DENIED
 *   4. CANCELLED visit                      → 400
 *   5. visitor identity not ACTIVE          → 400
 *   6. host confirmation PENDING            → 409
 *      host confirmation REJECTED           → 409 (never proceeds)
 *      (no confirmation record → allowed)
 *   7. duplicate active check-in            → 409
 *      (pre-check + partial unique index)
 *   8. future checkedInAt                   → 400
 *
 * Lifecycle: CHECKED_IN → CANCELLED (mistake reversal, atomic guard).
 * A cancelled check-in frees the visit for a fresh check-in.
 * Check-Out arrives in BE-13H — not here.
 */

const FUTURE_SKEW_TOLERANCE_MS = 60_000;

export async function checkInVisit(
  input: CreateVisitCheckInInput,
  userId: string,
): Promise<PublicVisitCheckIn> {
  if (
    (!input.expectedVisitorId && !input.walkInVisitId) ||
    (input.expectedVisitorId && input.walkInVisitId)
  ) {
    throw visitCheckInVisitReferenceRequiredError();
  }

  let visit: ExpectedVisitorRecord | WalkInVisitRecord;
  if (input.expectedVisitorId) {
    const expected = await expectedVisitorRepository.findById(
      input.expectedVisitorId,
    );
    if (!expected) {
      throw expectedVisitorNotFoundError();
    }
    visit = expected;
  } else {
    const walkIn = await walkInVisitRepository.findById(input.walkInVisitId!);
    if (!walkIn) {
      throw walkInVisitNotFoundError();
    }
    visit = walkIn;
  }

  await contextAccessService.assertBuildingAccess(userId, visit.buildingId);

  if (visit.status === 'CANCELLED') {
    throw visitCheckInVisitCancelledError();
  }

  // A specialized BE-13J contractor context remains metadata over this
  // same visit; cancellation blocks entry without introducing another
  // Check-In engine.
  const contractorContext = input.expectedVisitorId
    ? await contractorVisitorRepository.findByExpectedVisitor(
        input.expectedVisitorId,
      )
    : await contractorVisitorRepository.findByWalkInVisit(
        input.walkInVisitId!,
      );
  if (contractorContext?.status === 'CANCELLED') {
    throw contractorVisitorCancelledCheckInError();
  }

  // BE-13K delivery metadata uses this same visit when a courier is
  // handled as a visitor. Terminal delivery records cannot start a new
  // entry lifecycle.
  const deliveryContext = input.expectedVisitorId
    ? await deliveryCourierRepository.findByExpectedVisitor(
        input.expectedVisitorId,
      )
    : await deliveryCourierRepository.findByWalkInVisit(
        input.walkInVisitId!,
      );
  if (deliveryContext && deliveryContext.status !== 'ARRIVED') {
    throw deliveryCourierNotActiveForCheckInError();
  }

  // The visitor identity must still be valid for entry.
  const visitor = await visitorRepository.findById(visit.visitorId);
  if (!visitor || visitor.status !== 'ACTIVE') {
    throw visitCheckInVisitorNotActiveError();
  }

  // Confirmation gate: an existing BE-13F confirmation must be
  // CONFIRMED. No record → check-in allowed.
  const confirmation = input.expectedVisitorId
    ? await hostConfirmationRepository.findByExpectedVisitor(
        input.expectedVisitorId,
      )
    : await hostConfirmationRepository.findByWalkInVisit(input.walkInVisitId!);
  if (confirmation) {
    if (confirmation.status === 'PENDING') {
      throw visitCheckInConfirmationPendingError();
    }
    if (confirmation.status === 'REJECTED') {
      throw visitCheckInConfirmationRejectedError();
    }
  }

  // Duplicate active check-in pre-check.
  const active = input.expectedVisitorId
    ? await visitCheckInRepository.findActiveByExpectedVisitor(
        input.expectedVisitorId,
      )
    : await visitCheckInRepository.findActiveByWalkInVisit(
        input.walkInVisitId!,
      );
  if (active) {
    throw visitCheckInAlreadyCheckedInError();
  }

  if (input.checkedInAt) {
    const checkedIn = new Date(input.checkedInAt).getTime();
    if (checkedIn > Date.now() + FUTURE_SKEW_TOLERANCE_MS) {
      throw visitCheckInTimeInFutureError();
    }
  }

  let record: VisitCheckInRecord;
  try {
    record = await visitCheckInRepository.create({
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      visitorId: visit.visitorId,
      expectedVisitorId: input.expectedVisitorId ?? null,
      walkInVisitId: input.walkInVisitId ?? null,
      checkedInAt: input.checkedInAt ?? null,
      checkedInByUserId: input.checkedInByUserId,
      entryNotes: input.entryNotes ?? null,
    });
  } catch (error) {
    if (
      isUniqueViolation(error, 'visit_check_ins_active_expected_unique') ||
      isUniqueViolation(error, 'visit_check_ins_active_walk_in_unique')
    ) {
      throw visitCheckInAlreadyCheckedInError();
    }
    throw error;
  }
  return toPublicVisitCheckIn(record);
}

export async function getVisitCheckIn(
  id: string,
  userId: string,
): Promise<PublicVisitCheckIn> {
  const record = await visitCheckInRepository.findById(id);
  if (!record) {
    throw visitCheckInNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicVisitCheckIn(record);
}

export async function listVisitCheckIns(
  filters: VisitCheckInListFilters,
  userId: string,
): Promise<PublicVisitCheckIn[]> {
  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await visitCheckInRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicVisitCheckIn);
}

/**
 * Cancels (reverses) a mistaken check-in. Allowed only while the row
 * is still CHECKED_IN — the repository guard makes the flip atomic.
 * Cancelling frees the visit for a fresh check-in. A completed
 * (CHECKED_OUT) visit can never be cancelled — the closed history is
 * immutable.
 */
export async function cancelVisitCheckIn(
  id: string,
  userId: string,
): Promise<PublicVisitCheckIn> {
  const existing = await visitCheckInRepository.findById(id);
  if (!existing) {
    throw visitCheckInNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status === 'CHECKED_OUT') {
    throw visitCheckOutAlreadyCheckedOutError();
  }
  if (existing.status !== 'CHECKED_IN') {
    throw visitCheckInAlreadyCancelledError();
  }
  if (await visitorPassRepository.findActiveByVisitCheckInId(id)) {
    throw visitorPassActiveAtVisitClosureError();
  }

  let cancelled: VisitCheckInRecord | null;
  try {
    cancelled = await visitCheckInRepository.cancel(id);
  } catch (error) {
    if (
      isConstraintViolation(
        error,
        'visitor_passes_active_at_visit_closure',
      )
    ) {
      throw visitorPassActiveAtVisitClosureError();
    }
    throw error;
  }
  if (!cancelled) {
    throw visitCheckInAlreadyCancelledError();
  }
  return toPublicVisitCheckIn(cancelled);
}

/**
 * BE-13H — Check-Out. Closes an actively checked-in visit.
 *
 * Rules (pinned by tests):
 *   - the row must exist (404) in an accessible Building (403)
 *   - only CHECKED_IN rows can check out:
 *       already CHECKED_OUT → 409 ALREADY_CHECKED_OUT
 *       CANCELLED           → 409 NOT_ACTIVE
 *   - an ACTIVE BE-13I Visitor Pass must be returned or cancelled first
 *   - explicit checkedOutAt must not be in the future (60s skew) and
 *     must not precede the original check-in
 *   - the transition is atomic (repository WHERE status='CHECKED_IN'
 *     guard) so a duplicate/racing check-out can never double-apply
 *   - the original check-in history is preserved on the same row.
 */
export async function checkOutVisit(
  id: string,
  input: CheckOutVisitInput,
  userId: string,
): Promise<PublicVisitCheckIn> {
  const existing = await visitCheckInRepository.findById(id);
  if (!existing) {
    throw visitCheckInNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status === 'CHECKED_OUT') {
    throw visitCheckOutAlreadyCheckedOutError();
  }
  if (existing.status !== 'CHECKED_IN') {
    throw visitCheckOutNotActiveError();
  }
  if (await visitorPassRepository.findActiveByVisitCheckInId(id)) {
    throw visitorPassActiveAtVisitClosureError();
  }

  if (input.checkedOutAt) {
    const checkedOut = new Date(input.checkedOutAt).getTime();
    if (checkedOut > Date.now() + FUTURE_SKEW_TOLERANCE_MS) {
      throw visitCheckOutTimeInFutureError();
    }
    if (checkedOut < existing.checkedInAt.getTime()) {
      throw visitCheckOutBeforeCheckInError();
    }
  }

  let completed: VisitCheckInRecord | null;
  try {
    completed = await visitCheckInRepository.checkOut(id, {
      checkedOutAt: input.checkedOutAt ?? null,
      checkedOutByUserId: input.checkedOutByUserId,
      exitNotes: input.exitNotes ?? null,
    });
  } catch (error) {
    if (
      isConstraintViolation(
        error,
        'visitor_passes_active_at_visit_closure',
      )
    ) {
      throw visitorPassActiveAtVisitClosureError();
    }
    throw error;
  }
  if (!completed) {
    // The CHECKED_IN guard lost a race — the row was closed or
    // cancelled concurrently.
    throw visitCheckOutNotActiveError();
  }
  return toPublicVisitCheckIn(completed);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23514' && candidate.constraint === constraint;
}

function toPublicVisitCheckIn(record: VisitCheckInRecord): PublicVisitCheckIn {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    visitorId: record.visitorId,
    expectedVisitorId: record.expectedVisitorId,
    walkInVisitId: record.walkInVisitId,
    checkedInAt: record.checkedInAt.toISOString(),
    checkedInByUserId: record.checkedInByUserId,
    entryNotes: record.entryNotes,
    checkedOutAt: record.checkedOutAt
      ? record.checkedOutAt.toISOString()
      : null,
    checkedOutByUserId: record.checkedOutByUserId,
    exitNotes: record.exitNotes,
    status: record.status,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const visitCheckInService = {
  cancelVisitCheckIn,
  checkInVisit,
  checkOutVisit,
  getVisitCheckIn,
  listVisitCheckIns,
};

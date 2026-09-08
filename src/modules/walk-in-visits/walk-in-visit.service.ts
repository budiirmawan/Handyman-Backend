import { resolveAssetBuildingContext } from '../assets';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { organizationRepository } from '../organizations';
import { userNotFoundError, userRepository } from '../users';
import {
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import {
  visitorNotFoundError,
  visitorRepository,
  visitorService,
} from '../visitors';
import {
  walkInVisitAlreadyCancelledError,
  walkInVisitAlreadyRegisteredError,
  walkInVisitArrivalInFutureError,
  walkInVisitHostWorkforceInactiveError,
  walkInVisitHostWorkforceMismatchError,
  walkInVisitNotFoundError,
  walkInVisitVisitorBlockedError,
  walkInVisitVisitorClientMismatchError,
  walkInVisitVisitorInactiveError,
  walkInVisitVisitorReferenceRequiredError,
} from './walk-in-visit.errors';
import { walkInVisitRepository } from './walk-in-visit.repository';
import type {
  CreateWalkInVisitInput,
  PublicWalkInVisit,
  UpdateWalkInVisitInput,
  WalkInVisitListFilters,
  WalkInVisitRecord,
} from './walk-in-visit.types';

/**
 * BE-13D — Walk-In / Guest Book service.
 *
 * Front-desk guest-book layer for visitors WITHOUT a prior invitation.
 *
 * Identity rule: exactly ONE of
 *  - `visitorId`  — reuse an existing matched BE-13A identity, or
 *  - `newVisitor` — register a new identity INLINE through the BE-13A
 *    visitor service (same validation, per-Client duplicate handling
 *    and scoping — including the 409 on a duplicate identity document,
 *    which tells the front desk to search & reuse the match instead).
 * The walk-in module never writes the visitor master directly and
 * never creates a second visitor master.
 *
 * Duplicate handling: one open (REGISTERED) entry per
 * (building, visitor) — pre-check (clean 409) + partial unique index
 * (race safety). Cancelled entries never block a new registration.
 *
 * Host context is OPTIONAL for a walk-in; when supplied it is
 * validated like BE-13B/C (User exists; Workforce ACTIVE + same
 * Client).
 *
 * Arrival time: defaults to NOW; an explicit value must not be in the
 * future (60s clock-skew tolerance).
 *
 * Lifecycle: REGISTERED → CANCELLED (terminal, read-only afterwards).
 */

const FUTURE_SKEW_TOLERANCE_MS = 60_000;

export async function createWalkInVisit(
  input: CreateWalkInVisitInput,
  userId: string,
): Promise<PublicWalkInVisit> {
  if (
    (!input.visitorId && !input.newVisitor) ||
    (input.visitorId && input.newVisitor)
  ) {
    throw walkInVisitVisitorReferenceRequiredError();
  }

  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, input.buildingId);

  const { clientId } = await resolveAssetBuildingContext(input.buildingId);

  let visitorId: string;
  if (input.visitorId) {
    await assertExistingVisitor(input.visitorId, clientId);
    visitorId = input.visitorId;
  } else {
    // Inline registration delegates to the BE-13A service — shared
    // validation, duplicate document handling (409) and Client scoping.
    const created = await visitorService.createVisitor(
      {
        ...input.newVisitor!,
        clientId,
        createdByUserId: userId,
      },
      userId,
    );
    visitorId = created.id;
  }

  const openEntry = await walkInVisitRepository.findOpenByBuildingAndVisitor(
    input.buildingId,
    visitorId,
  );
  if (openEntry) {
    throw walkInVisitAlreadyRegisteredError();
  }

  if (input.hostUserId) {
    await assertHostUser(input.hostUserId);
  }
  if (input.hostWorkforceId) {
    await assertHostWorkforce(input.hostWorkforceId, clientId);
  }

  if (input.arrivedAt) {
    assertArrivalNotInFuture(input.arrivedAt);
  }

  let record: WalkInVisitRecord;
  try {
    record = await walkInVisitRepository.create({
      clientId,
      buildingId: input.buildingId,
      visitorId,
      hostUserId: input.hostUserId ?? null,
      hostWorkforceId: input.hostWorkforceId ?? null,
      hostName: input.hostName ?? null,
      purpose: input.purpose,
      arrivedAt: input.arrivedAt ?? null,
      frontDeskNotes: input.frontDeskNotes ?? null,
      createdByUserId: input.createdByUserId,
    });
  } catch (error) {
    if (isUniqueViolation(error, 'walk_in_visits_active_visitor_unique')) {
      throw walkInVisitAlreadyRegisteredError();
    }
    throw error;
  }
  return toPublicWalkInVisit(record);
}

export async function getWalkInVisit(
  id: string,
  userId: string,
): Promise<PublicWalkInVisit> {
  const record = await walkInVisitRepository.findById(id);
  if (!record) {
    throw walkInVisitNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicWalkInVisit(record);
}

export async function listWalkInVisits(
  filters: WalkInVisitListFilters,
  userId: string,
): Promise<PublicWalkInVisit[]> {
  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await walkInVisitRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicWalkInVisit);
}

export async function updateWalkInVisit(
  id: string,
  input: UpdateWalkInVisitInput,
  userId: string,
): Promise<PublicWalkInVisit> {
  const existing = await walkInVisitRepository.findById(id);
  if (!existing) {
    throw walkInVisitNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status === 'CANCELLED') {
    throw walkInVisitAlreadyCancelledError();
  }

  if (input.hostUserId) {
    await assertHostUser(input.hostUserId);
  }
  if (input.hostWorkforceId) {
    await assertHostWorkforce(input.hostWorkforceId, existing.clientId);
  }

  if (input.arrivedAt !== undefined) {
    assertArrivalNotInFuture(input.arrivedAt);
  }

  const updated = await walkInVisitRepository.update(id, input);
  if (!updated) {
    throw walkInVisitNotFoundError();
  }
  return toPublicWalkInVisit(updated);
}

/**
 * Cancels a REGISTERED guest-book entry (e.g. mistaken registration or
 * the guest left before being attended). CANCELLED is terminal.
 */
export async function cancelWalkInVisit(
  id: string,
  userId: string,
): Promise<PublicWalkInVisit> {
  const existing = await walkInVisitRepository.findById(id);
  if (!existing) {
    throw walkInVisitNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status === 'CANCELLED') {
    throw walkInVisitAlreadyCancelledError();
  }

  const updated = await walkInVisitRepository.update(id, {
    status: 'CANCELLED',
  });
  if (!updated) {
    throw walkInVisitNotFoundError();
  }
  return toPublicWalkInVisit(updated);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function assertExistingVisitor(
  visitorId: string,
  clientId: string,
): Promise<void> {
  const visitor = await visitorRepository.findById(visitorId);
  if (!visitor) {
    throw visitorNotFoundError();
  }
  if (visitor.clientId !== clientId) {
    throw walkInVisitVisitorClientMismatchError();
  }
  if (visitor.status === 'BLOCKED') {
    throw walkInVisitVisitorBlockedError();
  }
  if (visitor.status !== 'ACTIVE') {
    throw walkInVisitVisitorInactiveError();
  }
}

async function assertHostUser(hostUserId: string): Promise<void> {
  const user = await userRepository.findById(hostUserId);
  if (!user) {
    throw userNotFoundError();
  }
}

async function assertHostWorkforce(
  hostWorkforceId: string,
  clientId: string,
): Promise<void> {
  const profile = await workforceRepository.findById(hostWorkforceId);
  if (!profile) {
    throw workforceProfileNotFoundError();
  }
  if (profile.status !== 'ACTIVE') {
    throw walkInVisitHostWorkforceInactiveError();
  }
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    throw workforceProfileNotFoundError();
  }
  if (organization.clientId !== clientId) {
    throw walkInVisitHostWorkforceMismatchError();
  }
}

function assertArrivalNotInFuture(arrivedAtIso: string): void {
  const arrived = new Date(arrivedAtIso).getTime();
  if (arrived > Date.now() + FUTURE_SKEW_TOLERANCE_MS) {
    throw walkInVisitArrivalInFutureError();
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function toPublicWalkInVisit(record: WalkInVisitRecord): PublicWalkInVisit {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    visitorId: record.visitorId,
    hostUserId: record.hostUserId,
    hostWorkforceId: record.hostWorkforceId,
    hostName: record.hostName,
    purpose: record.purpose,
    arrivedAt: record.arrivedAt.toISOString(),
    frontDeskNotes: record.frontDeskNotes,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const walkInVisitService = {
  cancelWalkInVisit,
  createWalkInVisit,
  getWalkInVisit,
  listWalkInVisits,
  updateWalkInVisit,
};

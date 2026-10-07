import { resolveAssetBuildingContext } from '../assets';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import { organizationRepository } from '../organizations';
import { userNotFoundError, userRepository } from '../users';
import {
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import { visitorNotFoundError, visitorRepository } from '../visitors';
import {
  visitorInvitationNotFoundError,
  visitorInvitationRepository,
} from '../visitor-invitations';
import type { VisitorInvitationRecord } from '../visitor-invitations';
import {
  expectedVisitorAlreadyCancelledError,
  expectedVisitorContextRequiredError,
  expectedVisitorHostRequiredError,
  expectedVisitorHostWorkforceInactiveError,
  expectedVisitorHostWorkforceMismatchError,
  expectedVisitorInvalidTimeWindowError,
  expectedVisitorInvitationAlreadyUsedError,
  expectedVisitorInvitationCancelledError,
  expectedVisitorInvitationMismatchError,
  expectedVisitorNotFoundError,
  expectedVisitorVisitorBlockedError,
  expectedVisitorVisitorClientMismatchError,
  expectedVisitorVisitorInactiveError,
} from './expected-visitor.errors';
import { expectedVisitorRepository } from './expected-visitor.repository';
import type {
  CreateExpectedVisitorInput,
  ExpectedVisitorListFilters,
  ExpectedVisitorRecord,
  PublicExpectedVisitor,
  UpdateExpectedVisitorInput,
} from './expected-visitor.types';

/**
 * BE-13C — Expected Visitor service.
 *
 * Front-desk expectation layer on top of the shared BE-13A visitor
 * identity and the BE-13B invitation.
 *
 * Two creation paths:
 *  1. FROM INVITATION — `visitorInvitationId` supplied. Building /
 *     Visitor / host / window / purpose default from the (PENDING)
 *     invitation; explicit overrides must stay consistent (same
 *     Building, same Visitor). At most one non-cancelled expected
 *     visitor per invitation (service pre-check + partial unique index).
 *  2. STANDALONE — no invitation. buildingId, visitorId,
 *     expectedArrivalAt and purpose are required.
 *
 * Validation order (pinned by tests):
 *   1. invitation (when supplied): unknown → 404, CANCELLED → 400,
 *      Building/Visitor mismatch → 400, already used → 409
 *   2. unknown Building                   → 404 BUILDING_NOT_FOUND
 *   3. inaccessible Building              → 403 BUILDING_ACCESS_DENIED
 *   4. unknown / cross-Client / BLOCKED /
 *      INACTIVE Visitor                   → 404 / 400 / 400 / 400
 *   5. missing host reference             → 400 HOST_REQUIRED
 *   6. unknown host User                  → 404 USER_NOT_FOUND
 *   7. unknown / INACTIVE / cross-Client
 *      host Workforce                     → 404 / 400 / 400
 *   8. invalid time window                → 400 INVALID_TIME_WINDOW
 *
 * Lifecycle: EXPECTED → CANCELLED (terminal, read-only afterwards).
 */

export async function createExpectedVisitor(
  input: CreateExpectedVisitorInput,
  userId: string,
): Promise<PublicExpectedVisitor> {
  let invitation: VisitorInvitationRecord | null = null;

  if (input.visitorInvitationId) {
    invitation = await visitorInvitationRepository.findById(
      input.visitorInvitationId,
    );
    if (!invitation) {
      throw visitorInvitationNotFoundError();
    }
    if (invitation.status === 'CANCELLED') {
      throw expectedVisitorInvitationCancelledError();
    }
    if (
      (input.buildingId && input.buildingId !== invitation.buildingId) ||
      (input.visitorId && input.visitorId !== invitation.visitorId)
    ) {
      throw expectedVisitorInvitationMismatchError();
    }
  }

  const buildingId = input.buildingId ?? invitation?.buildingId;
  const visitorId = input.visitorId ?? invitation?.visitorId;
  const expectedArrivalAt =
    input.expectedArrivalAt ?? invitation?.expectedArrivalAt.toISOString();
  const purpose = input.purpose ?? invitation?.purpose;

  if (!buildingId || !visitorId || !expectedArrivalAt || !purpose) {
    throw expectedVisitorContextRequiredError();
  }

  const building = await buildingRepository.findById(buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, buildingId);

  if (invitation) {
    const existing = await expectedVisitorRepository.findActiveByInvitation(
      invitation.id,
    );
    if (existing) {
      throw expectedVisitorInvitationAlreadyUsedError();
    }
  }

  const { clientId } = await resolveAssetBuildingContext(buildingId);

  await assertVisitor(visitorId, clientId);

  // Host defaults from the invitation when not explicitly supplied.
  const hostUserId =
    input.hostUserId !== undefined
      ? input.hostUserId
      : (invitation?.hostUserId ?? null);
  const hostWorkforceId =
    input.hostWorkforceId !== undefined
      ? input.hostWorkforceId
      : (invitation?.hostWorkforceId ?? null);
  const hostName =
    input.hostName !== undefined
      ? input.hostName
      : (invitation?.hostName ?? null);

  if (!hostUserId && !hostWorkforceId && !hostName) {
    throw expectedVisitorHostRequiredError();
  }
  if (input.hostUserId) {
    await assertHostUser(input.hostUserId);
  }
  if (input.hostWorkforceId) {
    await assertHostWorkforce(input.hostWorkforceId, clientId);
  }

  const expectedDepartureAt =
    input.expectedDepartureAt !== undefined
      ? input.expectedDepartureAt
      : (invitation?.expectedDepartureAt?.toISOString() ?? null);
  assertTimeWindow(expectedArrivalAt, expectedDepartureAt);

  let record: ExpectedVisitorRecord;
  try {
    record = await expectedVisitorRepository.create({
      clientId,
      buildingId,
      visitorId,
      visitorInvitationId: invitation?.id ?? null,
      hostUserId,
      hostWorkforceId,
      hostName,
      expectedArrivalAt,
      expectedDepartureAt,
      purpose,
      notes: input.notes ?? null,
      createdByUserId: input.createdByUserId,
    });
  } catch (error) {
    if (
      isUniqueViolation(error, 'expected_visitors_active_invitation_unique')
    ) {
      throw expectedVisitorInvitationAlreadyUsedError();
    }
    throw error;
  }
  return toPublicExpectedVisitor(record);
}

export async function getExpectedVisitor(
  id: string,
  userId: string,
): Promise<PublicExpectedVisitor> {
  const record = await expectedVisitorRepository.findById(id);
  if (!record) {
    throw expectedVisitorNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicExpectedVisitor(record);
}

export async function listExpectedVisitors(
  filters: ExpectedVisitorListFilters,
  userId: string,
): Promise<PublicExpectedVisitor[]> {
  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await expectedVisitorRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicExpectedVisitor);
}

export async function updateExpectedVisitor(
  id: string,
  input: UpdateExpectedVisitorInput,
  userId: string,
): Promise<PublicExpectedVisitor> {
  const existing = await expectedVisitorRepository.findById(id);
  if (!existing) {
    throw expectedVisitorNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status === 'CANCELLED') {
    throw expectedVisitorAlreadyCancelledError();
  }

  // The updated record must still carry at least one host reference.
  const nextHostUserId =
    input.hostUserId !== undefined ? input.hostUserId : existing.hostUserId;
  const nextHostWorkforceId =
    input.hostWorkforceId !== undefined
      ? input.hostWorkforceId
      : existing.hostWorkforceId;
  const nextHostName =
    input.hostName !== undefined ? input.hostName : existing.hostName;
  if (!nextHostUserId && !nextHostWorkforceId && !nextHostName) {
    throw expectedVisitorHostRequiredError();
  }

  if (input.hostUserId) {
    await assertHostUser(input.hostUserId);
  }
  if (input.hostWorkforceId) {
    await assertHostWorkforce(input.hostWorkforceId, existing.clientId);
  }

  const nextArrival =
    input.expectedArrivalAt ?? existing.expectedArrivalAt.toISOString();
  const nextDeparture =
    input.expectedDepartureAt !== undefined
      ? input.expectedDepartureAt
      : (existing.expectedDepartureAt?.toISOString() ?? null);
  assertTimeWindow(nextArrival, nextDeparture);

  const updated = await expectedVisitorRepository.update(id, input);
  if (!updated) {
    throw expectedVisitorNotFoundError();
  }
  return toPublicExpectedVisitor(updated);
}

/**
 * Cancels an EXPECTED record. CANCELLED is terminal — repeated
 * cancellation is rejected.
 */
export async function cancelExpectedVisitor(
  id: string,
  userId: string,
): Promise<PublicExpectedVisitor> {
  const existing = await expectedVisitorRepository.findById(id);
  if (!existing) {
    throw expectedVisitorNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status === 'CANCELLED') {
    throw expectedVisitorAlreadyCancelledError();
  }

  const updated = await expectedVisitorRepository.update(id, {
    status: 'CANCELLED',
  });
  if (!updated) {
    throw expectedVisitorNotFoundError();
  }
  return toPublicExpectedVisitor(updated);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function assertVisitor(
  visitorId: string,
  clientId: string,
): Promise<void> {
  const visitor = await visitorRepository.findById(visitorId);
  if (!visitor) {
    throw visitorNotFoundError();
  }
  if (visitor.clientId !== clientId) {
    throw expectedVisitorVisitorClientMismatchError();
  }
  if (visitor.status === 'BLOCKED') {
    throw expectedVisitorVisitorBlockedError();
  }
  if (visitor.status !== 'ACTIVE') {
    throw expectedVisitorVisitorInactiveError();
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
    throw expectedVisitorHostWorkforceInactiveError();
  }
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    throw workforceProfileNotFoundError();
  }
  if (organization.clientId !== clientId) {
    throw expectedVisitorHostWorkforceMismatchError();
  }
}

function assertTimeWindow(
  arrivalIso: string,
  departureIso: string | null,
): void {
  if (!departureIso) {
    return;
  }
  const arrival = new Date(arrivalIso).getTime();
  const departure = new Date(departureIso).getTime();
  if (departure <= arrival) {
    throw expectedVisitorInvalidTimeWindowError();
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function toPublicExpectedVisitor(
  record: ExpectedVisitorRecord,
): PublicExpectedVisitor {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    visitorId: record.visitorId,
    visitorInvitationId: record.visitorInvitationId,
    hostUserId: record.hostUserId,
    hostWorkforceId: record.hostWorkforceId,
    hostName: record.hostName,
    expectedArrivalAt: record.expectedArrivalAt.toISOString(),
    expectedDepartureAt: record.expectedDepartureAt
      ? record.expectedDepartureAt.toISOString()
      : null,
    purpose: record.purpose,
    notes: record.notes,
    status: record.status,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const expectedVisitorService = {
  cancelExpectedVisitor,
  createExpectedVisitor,
  getExpectedVisitor,
  listExpectedVisitors,
  updateExpectedVisitor,
};

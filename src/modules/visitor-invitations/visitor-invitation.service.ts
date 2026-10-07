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
  visitorInvitationAlreadyCancelledError,
  visitorInvitationHostRequiredError,
  visitorInvitationHostWorkforceInactiveError,
  visitorInvitationHostWorkforceMismatchError,
  visitorInvitationInvalidTimeWindowError,
  visitorInvitationNotFoundError,
  visitorInvitationVisitorBlockedError,
  visitorInvitationVisitorClientMismatchError,
  visitorInvitationVisitorInactiveError,
} from './visitor-invitation.errors';
import { visitorInvitationRepository } from './visitor-invitation.repository';
import type {
  CreateVisitorInvitationInput,
  PublicVisitorInvitation,
  UpdateVisitorInvitationInput,
  VisitorInvitationListFilters,
  VisitorInvitationRecord,
} from './visitor-invitation.types';

/**
 * BE-13B — Visitor Invitation service.
 *
 * Visit-planning layer on top of the shared BE-13A visitor identity.
 * The invitation references the visitor master (never duplicates it),
 * anchors the visit to a Building (Client derived via Building →
 * Property → Client) and records the smallest safe host reference
 * (User / Workforce / free-form name).
 *
 * Validation order (pinned by tests):
 *   1. unknown Building                   → 404 BUILDING_NOT_FOUND
 *   2. inaccessible Building              → 403 BUILDING_ACCESS_DENIED
 *   3. unknown Visitor                    → 404 VISITOR_NOT_FOUND
 *   4. cross-Client Visitor               → 400 VISITOR_CLIENT_MISMATCH
 *   5. BLOCKED / INACTIVE Visitor         → 400
 *   6. missing host reference             → 400 HOST_REQUIRED
 *   7. unknown host User                  → 404 USER_NOT_FOUND
 *   8. unknown / INACTIVE / cross-Client
 *      host Workforce                     → 404 / 400 / 400
 *   9. invalid time window                → 400 INVALID_TIME_WINDOW
 *
 * Lifecycle: PENDING → CANCELLED (terminal). Cancelled invitations are
 * read-only.
 */

export async function createVisitorInvitation(
  input: CreateVisitorInvitationInput,
  userId: string,
): Promise<PublicVisitorInvitation> {
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    throw buildingNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, input.buildingId);

  const { clientId } = await resolveAssetBuildingContext(input.buildingId);

  await assertVisitor(input.visitorId, clientId);

  if (!input.hostUserId && !input.hostWorkforceId && !input.hostName) {
    throw visitorInvitationHostRequiredError();
  }
  if (input.hostUserId) {
    await assertHostUser(input.hostUserId);
  }
  if (input.hostWorkforceId) {
    await assertHostWorkforce(input.hostWorkforceId, clientId);
  }

  assertTimeWindow(input.expectedArrivalAt, input.expectedDepartureAt ?? null);

  const record = await visitorInvitationRepository.create({
    ...input,
    clientId,
  });
  return toPublicVisitorInvitation(record);
}

export async function getVisitorInvitation(
  id: string,
  userId: string,
): Promise<PublicVisitorInvitation> {
  const record = await visitorInvitationRepository.findById(id);
  if (!record) {
    throw visitorInvitationNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicVisitorInvitation(record);
}

export async function listVisitorInvitations(
  filters: VisitorInvitationListFilters,
  userId: string,
): Promise<PublicVisitorInvitation[]> {
  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await visitorInvitationRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicVisitorInvitation);
}

export async function updateVisitorInvitation(
  id: string,
  input: UpdateVisitorInvitationInput,
  userId: string,
): Promise<PublicVisitorInvitation> {
  const existing = await visitorInvitationRepository.findById(id);
  if (!existing) {
    throw visitorInvitationNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status === 'CANCELLED') {
    throw visitorInvitationAlreadyCancelledError();
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
    throw visitorInvitationHostRequiredError();
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

  const updated = await visitorInvitationRepository.update(id, input);
  if (!updated) {
    throw visitorInvitationNotFoundError();
  }
  return toPublicVisitorInvitation(updated);
}

/**
 * Cancels a PENDING invitation. CANCELLED is terminal — repeated
 * cancellation is rejected so front desks see a consistent state.
 */
export async function cancelVisitorInvitation(
  id: string,
  userId: string,
): Promise<PublicVisitorInvitation> {
  const existing = await visitorInvitationRepository.findById(id);
  if (!existing) {
    throw visitorInvitationNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status === 'CANCELLED') {
    throw visitorInvitationAlreadyCancelledError();
  }

  const updated = await visitorInvitationRepository.update(id, {
    status: 'CANCELLED',
  });
  if (!updated) {
    throw visitorInvitationNotFoundError();
  }
  return toPublicVisitorInvitation(updated);
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
    throw visitorInvitationVisitorClientMismatchError();
  }
  if (visitor.status === 'BLOCKED') {
    throw visitorInvitationVisitorBlockedError();
  }
  if (visitor.status !== 'ACTIVE') {
    throw visitorInvitationVisitorInactiveError();
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
    throw visitorInvitationHostWorkforceInactiveError();
  }
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    throw workforceProfileNotFoundError();
  }
  if (organization.clientId !== clientId) {
    throw visitorInvitationHostWorkforceMismatchError();
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
    throw visitorInvitationInvalidTimeWindowError();
  }
}

function toPublicVisitorInvitation(
  record: VisitorInvitationRecord,
): PublicVisitorInvitation {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    visitorId: record.visitorId,
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

export const visitorInvitationService = {
  cancelVisitorInvitation,
  createVisitorInvitation,
  getVisitorInvitation,
  listVisitorInvitations,
  updateVisitorInvitation,
};

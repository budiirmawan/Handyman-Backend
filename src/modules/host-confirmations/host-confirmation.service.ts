import { contextAccessService } from '../context-access';
import { organizationRepository } from '../organizations';
import { userNotFoundError, userRepository } from '../users';
import {
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
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
import {
  hostConfirmationAlreadyDecidedError,
  hostConfirmationAlreadyExistsError,
  hostConfirmationHostRequiredError,
  hostConfirmationHostWorkforceInactiveError,
  hostConfirmationHostWorkforceMismatchError,
  hostConfirmationNotFoundError,
  hostConfirmationVisitCancelledError,
  hostConfirmationVisitReferenceRequiredError,
} from './host-confirmation.errors';
import { hostConfirmationRepository } from './host-confirmation.repository';
import type {
  ConfirmHostConfirmationInput,
  CreateHostConfirmationInput,
  HostConfirmationListFilters,
  HostConfirmationRecord,
  PublicHostConfirmation,
  RejectHostConfirmationInput,
} from './host-confirmation.types';

/**
 * BE-13F — Host / Tenant Confirmation service.
 *
 * Backend-authoritative confirmation layer over the existing BE-13
 * visit contexts (Expected Visitor / Walk-In). No new Tenant domain —
 * host context reuses the minimal references established by
 * BE-13B/C/D, defaulted from the visit and overridable with
 * validation.
 *
 * Rules (pinned by tests):
 *  - exactly one visit reference (expectedVisitorId XOR walkInVisitId)
 *  - the visit must exist and not be CANCELLED
 *  - one confirmation per visit (pre-check 409 + partial unique index)
 *  - host references validated (User exists; Workforce ACTIVE + same
 *    Client); at least one host reference after defaulting
 *  - decision is single-shot and atomic: PENDING → CONFIRMED |
 *    REJECTED (the repository guards `status = 'PENDING'` in the
 *    UPDATE so concurrent decisions cannot both win)
 *  - REJECTED can never become CONFIRMED
 *  - Building / Client context derives from the visit row — never
 *    caller-supplied.
 */

export async function requestHostConfirmation(
  input: CreateHostConfirmationInput,
  userId: string,
): Promise<PublicHostConfirmation> {
  if (
    (!input.expectedVisitorId && !input.walkInVisitId) ||
    (input.expectedVisitorId && input.walkInVisitId)
  ) {
    throw hostConfirmationVisitReferenceRequiredError();
  }

  let visit: {
    buildingId: string;
    clientId: string;
    hostUserId: string | null;
    hostWorkforceId: string | null;
    hostName: string | null;
  };

  if (input.expectedVisitorId) {
    const expected = await expectedVisitorRepository.findById(
      input.expectedVisitorId,
    );
    if (!expected) {
      throw expectedVisitorNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(
      userId,
      expected.buildingId,
    );
    if (expected.status === 'CANCELLED') {
      throw hostConfirmationVisitCancelledError();
    }
    const existing = await hostConfirmationRepository.findByExpectedVisitor(
      expected.id,
    );
    if (existing) {
      throw hostConfirmationAlreadyExistsError();
    }
    visit = toVisitContext(expected);
  } else {
    const walkIn = await walkInVisitRepository.findById(input.walkInVisitId!);
    if (!walkIn) {
      throw walkInVisitNotFoundError();
    }
    await contextAccessService.assertBuildingAccess(userId, walkIn.buildingId);
    if (walkIn.status === 'CANCELLED') {
      throw hostConfirmationVisitCancelledError();
    }
    const existing = await hostConfirmationRepository.findByWalkInVisit(
      walkIn.id,
    );
    if (existing) {
      throw hostConfirmationAlreadyExistsError();
    }
    visit = toVisitContext(walkIn);
  }

  // Host context: explicit values override, otherwise default from the
  // visit record.
  const hostUserId =
    input.hostUserId !== undefined ? input.hostUserId : visit.hostUserId;
  const hostWorkforceId =
    input.hostWorkforceId !== undefined
      ? input.hostWorkforceId
      : visit.hostWorkforceId;
  const hostName =
    input.hostName !== undefined ? input.hostName : visit.hostName;

  if (!hostUserId && !hostWorkforceId && !hostName) {
    throw hostConfirmationHostRequiredError();
  }
  if (input.hostUserId) {
    await assertHostUser(input.hostUserId);
  }
  if (input.hostWorkforceId) {
    await assertHostWorkforce(input.hostWorkforceId, visit.clientId);
  }

  let record: HostConfirmationRecord;
  try {
    record = await hostConfirmationRepository.create({
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      expectedVisitorId: input.expectedVisitorId ?? null,
      walkInVisitId: input.walkInVisitId ?? null,
      hostUserId,
      hostWorkforceId,
      hostName,
      notes: input.notes ?? null,
      createdByUserId: input.createdByUserId,
    });
  } catch (error) {
    if (
      isUniqueViolation(error, 'host_confirmations_expected_visitor_unique') ||
      isUniqueViolation(error, 'host_confirmations_walk_in_unique')
    ) {
      throw hostConfirmationAlreadyExistsError();
    }
    throw error;
  }
  return toPublicHostConfirmation(record);
}

export async function getHostConfirmation(
  id: string,
  userId: string,
): Promise<PublicHostConfirmation> {
  const record = await hostConfirmationRepository.findById(id);
  if (!record) {
    throw hostConfirmationNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicHostConfirmation(record);
}

export async function listHostConfirmations(
  filters: HostConfirmationListFilters,
  userId: string,
): Promise<PublicHostConfirmation[]> {
  let buildingIds: string[];

  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await hostConfirmationRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicHostConfirmation);
}

/** Confirms a PENDING visit confirmation (single-shot). */
export async function confirmVisit(
  id: string,
  input: ConfirmHostConfirmationInput,
  userId: string,
): Promise<PublicHostConfirmation> {
  const existing = await hostConfirmationRepository.findById(id);
  if (!existing) {
    throw hostConfirmationNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status !== 'PENDING') {
    throw hostConfirmationAlreadyDecidedError();
  }

  const decided = await hostConfirmationRepository.decide(id, {
    status: 'CONFIRMED',
    confirmedByUserId: userId,
    rejectionReason: null,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  if (!decided) {
    // The PENDING guard lost a race — the row was decided concurrently.
    throw hostConfirmationAlreadyDecidedError();
  }
  return toPublicHostConfirmation(decided);
}

/**
 * Rejects a PENDING visit confirmation (single-shot, requires a
 * reason). A REJECTED visit can never proceed as confirmed.
 */
export async function rejectVisit(
  id: string,
  input: RejectHostConfirmationInput,
  userId: string,
): Promise<PublicHostConfirmation> {
  const existing = await hostConfirmationRepository.findById(id);
  if (!existing) {
    throw hostConfirmationNotFoundError();
  }
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status !== 'PENDING') {
    throw hostConfirmationAlreadyDecidedError();
  }

  const decided = await hostConfirmationRepository.decide(id, {
    status: 'REJECTED',
    confirmedByUserId: userId,
    rejectionReason: input.rejectionReason,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });
  if (!decided) {
    throw hostConfirmationAlreadyDecidedError();
  }
  return toPublicHostConfirmation(decided);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function toVisitContext(
  visit: ExpectedVisitorRecord | WalkInVisitRecord,
): {
  buildingId: string;
  clientId: string;
  hostUserId: string | null;
  hostWorkforceId: string | null;
  hostName: string | null;
} {
  return {
    buildingId: visit.buildingId,
    clientId: visit.clientId,
    hostUserId: visit.hostUserId,
    hostWorkforceId: visit.hostWorkforceId,
    hostName: visit.hostName,
  };
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
    throw hostConfirmationHostWorkforceInactiveError();
  }
  const organization = await organizationRepository.findById(
    profile.organizationId,
  );
  if (!organization) {
    throw workforceProfileNotFoundError();
  }
  if (organization.clientId !== clientId) {
    throw hostConfirmationHostWorkforceMismatchError();
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function toPublicHostConfirmation(
  record: HostConfirmationRecord,
): PublicHostConfirmation {
  return {
    id: record.id,
    clientId: record.clientId,
    buildingId: record.buildingId,
    expectedVisitorId: record.expectedVisitorId,
    walkInVisitId: record.walkInVisitId,
    hostUserId: record.hostUserId,
    hostWorkforceId: record.hostWorkforceId,
    hostName: record.hostName,
    status: record.status,
    confirmedByUserId: record.confirmedByUserId,
    confirmedAt: record.confirmedAt ? record.confirmedAt.toISOString() : null,
    rejectionReason: record.rejectionReason,
    notes: record.notes,
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const hostConfirmationService = {
  confirmVisit,
  getHostConfirmation,
  listHostConfirmations,
  rejectVisit,
  requestHostConfirmation,
};

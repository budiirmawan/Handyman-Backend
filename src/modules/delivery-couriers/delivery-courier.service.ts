import { resolveAssetBuildingContext } from '../assets';
import { buildingAssignmentRepository } from '../building-assignments';
import { buildingNotFoundError, buildingRepository } from '../buildings';
import { contextAccessService } from '../context-access';
import {
  expectedVisitorNotFoundError,
  expectedVisitorRepository,
} from '../expected-visitors';
import type { ExpectedVisitorRecord } from '../expected-visitors';
import { organizationRepository } from '../organizations';
import { userNotFoundError, userRepository } from '../users';
import { visitCheckInRepository } from '../visit-check-ins/visit-check-in.repository';
import { visitorNotFoundError, visitorRepository } from '../visitors';
import {
  walkInVisitNotFoundError,
  walkInVisitRepository,
} from '../walk-in-visits';
import type { WalkInVisitRecord } from '../walk-in-visits';
import { workforceBuildingAssignmentRepository } from '../workforce-building-assignments';
import {
  workforceProfileNotFoundError,
  workforceRepository,
} from '../workforce';
import {
  deliveryCourierActiveVisitError,
  deliveryCourierAlreadyExistsError,
  deliveryCourierArrivalInFutureError,
  deliveryCourierContextMismatchError,
  deliveryCourierContextRequiredError,
  deliveryCourierCourierRequiredError,
  deliveryCourierInvalidTransitionError,
  deliveryCourierNotFoundError,
  deliveryCourierRecipientBuildingMismatchError,
  deliveryCourierRecipientRequiredError,
  deliveryCourierRecipientUserNotActiveError,
  deliveryCourierRecipientWorkforceInactiveError,
  deliveryCourierRecipientWorkforceMismatchError,
  deliveryCourierVisitCancelledError,
  deliveryCourierVisitReferenceInvalidError,
  deliveryCourierVisitorClientMismatchError,
  deliveryCourierVisitorNotActiveError,
} from './delivery-courier.errors';
import { deliveryCourierRepository } from './delivery-courier.repository';
import type {
  CreateDeliveryCourierInput,
  DeliveryCourierListFilters,
  DeliveryCourierRecord,
  PublicDeliveryCourier,
  UpdateDeliveryCourierStatusInput,
} from './delivery-courier.types';

type VisitContext = ExpectedVisitorRecord | WalkInVisitRecord;
const FUTURE_SKEW_TOLERANCE_MS = 60_000;

/**
 * BE-13K — Delivery / Courier service.
 *
 * A linked visit supplies authoritative Client, Building, Visitor and
 * default recipient/host context. A record without a visit remains a
 * Building-scoped package receipt and may optionally reference an existing
 * Visitor identity. No courier account, dispatch or Front Desk Log engine
 * is created here.
 */
export async function createDeliveryCourier(
  input: CreateDeliveryCourierInput,
  userId: string,
): Promise<PublicDeliveryCourier> {
  if (input.expectedVisitorId && input.walkInVisitId) {
    throw deliveryCourierVisitReferenceInvalidError();
  }
  if (!input.courierCompany && !input.courierName) {
    throw deliveryCourierCourierRequiredError();
  }

  const visit = await resolveOptionalVisit(input);
  let clientId: string;
  let buildingId: string;
  let visitorId: string | null;

  if (visit) {
    await contextAccessService.assertBuildingAccess(userId, visit.buildingId);
    if (
      (input.buildingId && input.buildingId !== visit.buildingId) ||
      (input.visitorId !== undefined && input.visitorId !== visit.visitorId)
    ) {
      throw deliveryCourierContextMismatchError();
    }
    if (visit.status === 'CANCELLED') {
      throw deliveryCourierVisitCancelledError();
    }
    clientId = visit.clientId;
    buildingId = visit.buildingId;
    visitorId = visit.visitorId;
  } else {
    if (!input.buildingId) throw deliveryCourierContextRequiredError();
    const building = await buildingRepository.findById(input.buildingId);
    if (!building) throw buildingNotFoundError();
    await contextAccessService.assertBuildingAccess(userId, input.buildingId);
    ({ clientId } = await resolveAssetBuildingContext(input.buildingId));
    buildingId = input.buildingId;
    visitorId = input.visitorId ?? null;
  }

  if (visitorId) {
    await assertVisitor(visitorId, clientId);
  }

  const recipientUserId =
    input.recipientUserId !== undefined
      ? input.recipientUserId
      : (visit?.hostUserId ?? null);
  const recipientWorkforceId =
    input.recipientWorkforceId !== undefined
      ? input.recipientWorkforceId
      : (visit?.hostWorkforceId ?? null);
  const recipientName =
    input.recipientName !== undefined
      ? input.recipientName
      : (visit?.hostName ?? null);

  if (!recipientUserId && !recipientWorkforceId && !recipientName) {
    throw deliveryCourierRecipientRequiredError();
  }
  if (recipientUserId) {
    await assertRecipientUser(recipientUserId, buildingId);
  }
  if (recipientWorkforceId) {
    await assertRecipientWorkforce(
      recipientWorkforceId,
      clientId,
      buildingId,
    );
  }

  if (input.arrivedAt) {
    const arrivedAt = new Date(input.arrivedAt).getTime();
    if (arrivedAt > Date.now() + FUTURE_SKEW_TOLERANCE_MS) {
      throw deliveryCourierArrivalInFutureError();
    }
  }

  const existing = input.expectedVisitorId
    ? await deliveryCourierRepository.findByExpectedVisitor(
        input.expectedVisitorId,
      )
    : input.walkInVisitId
      ? await deliveryCourierRepository.findByWalkInVisit(input.walkInVisitId)
      : null;
  if (existing) throw deliveryCourierAlreadyExistsError();

  let record: DeliveryCourierRecord;
  try {
    record = await deliveryCourierRepository.create({
      clientId,
      buildingId,
      visitorId,
      expectedVisitorId: input.expectedVisitorId ?? null,
      walkInVisitId: input.walkInVisitId ?? null,
      deliveryType: input.deliveryType,
      courierCompany: input.courierCompany ?? null,
      courierName: input.courierName ?? null,
      recipientUserId,
      recipientWorkforceId,
      recipientName,
      arrivedAt: input.arrivedAt ?? null,
      referenceNumber: input.referenceNumber ?? null,
      notes: input.notes ?? null,
      createdByUserId: input.createdByUserId,
    });
  } catch (error) {
    if (
      isUniqueViolation(error, 'delivery_couriers_expected_visit_unique') ||
      isUniqueViolation(error, 'delivery_couriers_walk_in_visit_unique')
    ) {
      throw deliveryCourierAlreadyExistsError();
    }
    throw error;
  }
  return toPublicDeliveryCourier(record);
}

export async function getDeliveryCourier(
  id: string,
  userId: string,
): Promise<PublicDeliveryCourier> {
  const record = await deliveryCourierRepository.findById(id);
  if (!record) throw deliveryCourierNotFoundError();
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicDeliveryCourier(record);
}

export async function listDeliveryCouriers(
  filters: DeliveryCourierListFilters,
  userId: string,
): Promise<PublicDeliveryCourier[]> {
  let buildingIds: string[];
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await deliveryCourierRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicDeliveryCourier);
}

export async function updateDeliveryCourierStatus(
  id: string,
  input: UpdateDeliveryCourierStatusInput,
  userId: string,
): Promise<PublicDeliveryCourier> {
  const existing = await deliveryCourierRepository.findById(id);
  if (!existing) throw deliveryCourierNotFoundError();
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status !== 'ARRIVED') {
    throw deliveryCourierInvalidTransitionError();
  }

  if (input.status === 'REJECTED' || input.status === 'CANCELLED') {
    const activeCheckIn = existing.expectedVisitorId
      ? await visitCheckInRepository.findActiveByExpectedVisitor(
          existing.expectedVisitorId,
        )
      : existing.walkInVisitId
        ? await visitCheckInRepository.findActiveByWalkInVisit(
            existing.walkInVisitId,
          )
        : null;
    if (activeCheckIn) throw deliveryCourierActiveVisitError();
  }

  const updated = await deliveryCourierRepository.updateStatus(id, input);
  if (!updated) throw deliveryCourierInvalidTransitionError();
  return toPublicDeliveryCourier(updated);
}

async function resolveOptionalVisit(
  input: Pick<
    CreateDeliveryCourierInput,
    'expectedVisitorId' | 'walkInVisitId'
  >,
): Promise<VisitContext | null> {
  if (input.expectedVisitorId) {
    const visit = await expectedVisitorRepository.findById(
      input.expectedVisitorId,
    );
    if (!visit) throw expectedVisitorNotFoundError();
    return visit;
  }
  if (input.walkInVisitId) {
    const visit = await walkInVisitRepository.findById(input.walkInVisitId);
    if (!visit) throw walkInVisitNotFoundError();
    return visit;
  }
  return null;
}

async function assertVisitor(visitorId: string, clientId: string): Promise<void> {
  const visitor = await visitorRepository.findById(visitorId);
  if (!visitor) throw visitorNotFoundError();
  if (visitor.clientId !== clientId) {
    throw deliveryCourierVisitorClientMismatchError();
  }
  if (visitor.status !== 'ACTIVE') {
    throw deliveryCourierVisitorNotActiveError();
  }
}

async function assertRecipientUser(
  recipientUserId: string,
  buildingId: string,
): Promise<void> {
  const user = await userRepository.findById(recipientUserId);
  if (!user) throw userNotFoundError();
  if (user.status !== 'ACTIVE') {
    throw deliveryCourierRecipientUserNotActiveError();
  }
  const assignment =
    await buildingAssignmentRepository.findActiveByUserAndBuilding(
      recipientUserId,
      buildingId,
    );
  if (!assignment) throw deliveryCourierRecipientBuildingMismatchError();
}

async function assertRecipientWorkforce(
  workforceId: string,
  clientId: string,
  buildingId: string,
): Promise<void> {
  const workforce = await workforceRepository.findById(workforceId);
  if (!workforce) throw workforceProfileNotFoundError();
  if (workforce.status !== 'ACTIVE') {
    throw deliveryCourierRecipientWorkforceInactiveError();
  }
  const organization = await organizationRepository.findById(
    workforce.organizationId,
  );
  if (!organization || organization.clientId !== clientId) {
    throw deliveryCourierRecipientWorkforceMismatchError();
  }
  const assignments =
    await workforceBuildingAssignmentRepository.listEffectiveByWorkforceProfileId(
      workforceId,
      new Date(),
    );
  if (!assignments.some((context) => context.building.id === buildingId)) {
    throw deliveryCourierRecipientBuildingMismatchError();
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function toPublicDeliveryCourier(
  record: DeliveryCourierRecord,
): PublicDeliveryCourier {
  return {
    ...record,
    arrivedAt: record.arrivedAt.toISOString(),
    statusUpdatedAt: record.statusUpdatedAt
      ? record.statusUpdatedAt.toISOString()
      : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const deliveryCourierService = {
  createDeliveryCourier,
  getDeliveryCourier,
  listDeliveryCouriers,
  updateDeliveryCourierStatus,
};

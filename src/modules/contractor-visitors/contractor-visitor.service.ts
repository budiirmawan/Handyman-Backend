import { buildingAssignmentRepository } from '../building-assignments';
import { contextAccessService } from '../context-access';
import {
  expectedVisitorNotFoundError,
  expectedVisitorRepository,
} from '../expected-visitors';
import type { ExpectedVisitorRecord } from '../expected-visitors';
import {
  functionalLocationNotFoundError,
  functionalLocationRepository,
} from '../functional-locations';
import { organizationRepository } from '../organizations';
import { userNotFoundError, userRepository } from '../users';
import { visitCheckInRepository } from '../visit-check-ins/visit-check-in.repository';
import { visitorRepository } from '../visitors';
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
  contractorVisitorActiveVisitError,
  contractorVisitorAlreadyCancelledError,
  contractorVisitorAlreadyExistsError,
  contractorVisitorHostBuildingMismatchError,
  contractorVisitorHostRequiredError,
  contractorVisitorHostUserNotActiveError,
  contractorVisitorHostWorkforceInactiveError,
  contractorVisitorHostWorkforceMismatchError,
  contractorVisitorLocationBuildingMismatchError,
  contractorVisitorLocationInactiveError,
  contractorVisitorNotFoundError,
  contractorVisitorVisitCancelledError,
  contractorVisitorVisitMismatchError,
  contractorVisitorVisitReferenceRequiredError,
  contractorVisitorVisitorNotActiveError,
} from './contractor-visitor.errors';
import { contractorVisitorRepository } from './contractor-visitor.repository';
import type {
  ContractorVisitorListFilters,
  ContractorVisitorRecord,
  CreateContractorVisitorInput,
  PublicContractorVisitor,
  UpdateContractorVisitorInput,
} from './contractor-visitor.types';

type VisitContext = ExpectedVisitorRecord | WalkInVisitRecord;

/**
 * BE-13J — Contractor Visitor service.
 *
 * The contractor row only specializes an existing Expected Visitor or
 * Walk-In visit. Client, Building and Visitor are copied from that
 * authoritative visit after consistency checks; all entry, exit and pass
 * operations continue through BE-13G/H/I.
 */
export async function createContractorVisitor(
  input: CreateContractorVisitorInput,
  userId: string,
): Promise<PublicContractorVisitor> {
  assertExactlyOneVisitReference(input);

  const visit = await resolveVisit(input);
  await contextAccessService.assertBuildingAccess(userId, visit.buildingId);

  if (
    (input.buildingId && input.buildingId !== visit.buildingId) ||
    (input.visitorId && input.visitorId !== visit.visitorId)
  ) {
    throw contractorVisitorVisitMismatchError();
  }
  if (visit.status === 'CANCELLED') {
    throw contractorVisitorVisitCancelledError();
  }

  const visitor = await visitorRepository.findById(visit.visitorId);
  if (!visitor || visitor.clientId !== visit.clientId) {
    throw contractorVisitorVisitMismatchError();
  }
  if (visitor.status !== 'ACTIVE') {
    throw contractorVisitorVisitorNotActiveError();
  }

  const existing = input.expectedVisitorId
    ? await contractorVisitorRepository.findByExpectedVisitor(
        input.expectedVisitorId,
      )
    : await contractorVisitorRepository.findByWalkInVisit(
        input.walkInVisitId!,
      );
  if (existing) {
    throw contractorVisitorAlreadyExistsError();
  }

  const responsibleHostUserId =
    input.responsibleHostUserId !== undefined
      ? input.responsibleHostUserId
      : visit.hostUserId;
  const responsibleHostWorkforceId =
    input.responsibleHostWorkforceId !== undefined
      ? input.responsibleHostWorkforceId
      : visit.hostWorkforceId;
  const responsibleHostName =
    input.responsibleHostName !== undefined
      ? input.responsibleHostName
      : visit.hostName;

  assertHostPresent(
    responsibleHostUserId,
    responsibleHostWorkforceId,
    responsibleHostName,
  );
  if (responsibleHostUserId) {
    await assertResponsibleHostUser(responsibleHostUserId, visit.buildingId);
  }
  if (responsibleHostWorkforceId) {
    await assertResponsibleHostWorkforce(
      responsibleHostWorkforceId,
      visit.clientId,
      visit.buildingId,
    );
  }
  if (input.functionalLocationId) {
    await assertFunctionalLocation(
      input.functionalLocationId,
      visit.buildingId,
    );
  }

  let record: ContractorVisitorRecord;
  try {
    record = await contractorVisitorRepository.create({
      clientId: visit.clientId,
      buildingId: visit.buildingId,
      visitorId: visit.visitorId,
      expectedVisitorId: input.expectedVisitorId ?? null,
      walkInVisitId: input.walkInVisitId ?? null,
      contractorCompany: input.contractorCompany,
      contractorPurpose: input.contractorPurpose,
      responsibleHostUserId,
      responsibleHostWorkforceId,
      responsibleHostName,
      functionalLocationId: input.functionalLocationId ?? null,
      workLocation: input.workLocation ?? null,
      notes: input.notes ?? null,
      createdByUserId: input.createdByUserId,
    });
  } catch (error) {
    if (
      isUniqueViolation(
        error,
        'contractor_visitors_expected_visit_unique',
      ) ||
      isUniqueViolation(error, 'contractor_visitors_walk_in_visit_unique')
    ) {
      throw contractorVisitorAlreadyExistsError();
    }
    throw error;
  }

  return toPublicContractorVisitor(record);
}

export async function getContractorVisitor(
  id: string,
  userId: string,
): Promise<PublicContractorVisitor> {
  const record = await contractorVisitorRepository.findById(id);
  if (!record) throw contractorVisitorNotFoundError();
  await contextAccessService.assertBuildingAccess(userId, record.buildingId);
  return toPublicContractorVisitor(record);
}

export async function listContractorVisitors(
  filters: ContractorVisitorListFilters,
  userId: string,
): Promise<PublicContractorVisitor[]> {
  let buildingIds: string[];
  if (filters.buildingId) {
    await contextAccessService.assertBuildingAccess(userId, filters.buildingId);
    buildingIds = [filters.buildingId];
  } else {
    buildingIds = await contextAccessService.getAccessibleBuildingIds(userId);
  }

  const records = await contractorVisitorRepository.listByBuildingIds(
    buildingIds,
    filters,
  );
  return records.map(toPublicContractorVisitor);
}

export async function updateContractorVisitor(
  id: string,
  input: UpdateContractorVisitorInput,
  userId: string,
): Promise<PublicContractorVisitor> {
  const existing = await contractorVisitorRepository.findById(id);
  if (!existing) throw contractorVisitorNotFoundError();
  await contextAccessService.assertBuildingAccess(userId, existing.buildingId);

  if (existing.status === 'CANCELLED') {
    throw contractorVisitorAlreadyCancelledError();
  }

  const nextHostUserId =
    input.responsibleHostUserId !== undefined
      ? input.responsibleHostUserId
      : existing.responsibleHostUserId;
  const nextHostWorkforceId =
    input.responsibleHostWorkforceId !== undefined
      ? input.responsibleHostWorkforceId
      : existing.responsibleHostWorkforceId;
  const nextHostName =
    input.responsibleHostName !== undefined
      ? input.responsibleHostName
      : existing.responsibleHostName;
  assertHostPresent(nextHostUserId, nextHostWorkforceId, nextHostName);

  if (input.responsibleHostUserId) {
    await assertResponsibleHostUser(
      input.responsibleHostUserId,
      existing.buildingId,
    );
  }
  if (input.responsibleHostWorkforceId) {
    await assertResponsibleHostWorkforce(
      input.responsibleHostWorkforceId,
      existing.clientId,
      existing.buildingId,
    );
  }
  if (input.functionalLocationId) {
    await assertFunctionalLocation(
      input.functionalLocationId,
      existing.buildingId,
    );
  }

  if (input.status === 'CANCELLED') {
    const activeCheckIn = existing.expectedVisitorId
      ? await visitCheckInRepository.findActiveByExpectedVisitor(
          existing.expectedVisitorId,
        )
      : await visitCheckInRepository.findActiveByWalkInVisit(
          existing.walkInVisitId!,
        );
    if (activeCheckIn) {
      throw contractorVisitorActiveVisitError();
    }
  }

  const updated = await contractorVisitorRepository.update(id, input);
  if (!updated) throw contractorVisitorNotFoundError();
  return toPublicContractorVisitor(updated);
}

function assertExactlyOneVisitReference(
  input: Pick<
    CreateContractorVisitorInput,
    'expectedVisitorId' | 'walkInVisitId'
  >,
): void {
  if (
    (!input.expectedVisitorId && !input.walkInVisitId) ||
    (input.expectedVisitorId && input.walkInVisitId)
  ) {
    throw contractorVisitorVisitReferenceRequiredError();
  }
}

async function resolveVisit(
  input: Pick<
    CreateContractorVisitorInput,
    'expectedVisitorId' | 'walkInVisitId'
  >,
): Promise<VisitContext> {
  if (input.expectedVisitorId) {
    const visit = await expectedVisitorRepository.findById(
      input.expectedVisitorId,
    );
    if (!visit) throw expectedVisitorNotFoundError();
    return visit;
  }
  const visit = await walkInVisitRepository.findById(input.walkInVisitId!);
  if (!visit) throw walkInVisitNotFoundError();
  return visit;
}

function assertHostPresent(
  userId: string | null,
  workforceId: string | null,
  name: string | null,
): void {
  if (!userId && !workforceId && !name) {
    throw contractorVisitorHostRequiredError();
  }
}

async function assertResponsibleHostUser(
  hostUserId: string,
  buildingId: string,
): Promise<void> {
  const user = await userRepository.findById(hostUserId);
  if (!user) throw userNotFoundError();
  if (user.status !== 'ACTIVE') {
    throw contractorVisitorHostUserNotActiveError();
  }
  const assignment =
    await buildingAssignmentRepository.findActiveByUserAndBuilding(
      hostUserId,
      buildingId,
    );
  if (!assignment) throw contractorVisitorHostBuildingMismatchError();
}

async function assertResponsibleHostWorkforce(
  workforceId: string,
  clientId: string,
  buildingId: string,
): Promise<void> {
  const workforce = await workforceRepository.findById(workforceId);
  if (!workforce) throw workforceProfileNotFoundError();
  if (workforce.status !== 'ACTIVE') {
    throw contractorVisitorHostWorkforceInactiveError();
  }

  const organization = await organizationRepository.findById(
    workforce.organizationId,
  );
  if (!organization || organization.clientId !== clientId) {
    throw contractorVisitorHostWorkforceMismatchError();
  }

  const assignments =
    await workforceBuildingAssignmentRepository.listEffectiveByWorkforceProfileId(
      workforceId,
      new Date(),
    );
  if (!assignments.some((context) => context.building.id === buildingId)) {
    throw contractorVisitorHostBuildingMismatchError();
  }
}

async function assertFunctionalLocation(
  functionalLocationId: string,
  buildingId: string,
): Promise<void> {
  const location = await functionalLocationRepository.findById(
    functionalLocationId,
  );
  if (!location) throw functionalLocationNotFoundError();
  if (location.buildingId !== buildingId) {
    throw contractorVisitorLocationBuildingMismatchError();
  }
  if (location.status !== 'ACTIVE') {
    throw contractorVisitorLocationInactiveError();
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; constraint?: string };
  return candidate.code === '23505' && candidate.constraint === constraint;
}

function toPublicContractorVisitor(
  record: ContractorVisitorRecord,
): PublicContractorVisitor {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export const contractorVisitorService = {
  createContractorVisitor,
  getContractorVisitor,
  listContractorVisitors,
  updateContractorVisitor,
};
